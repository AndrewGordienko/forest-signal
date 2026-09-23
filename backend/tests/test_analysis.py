import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.analysis import (
    AnalysisError,
    Z,
    aggregate_se,
    analyze,
    change_se,
    classification,
)
from backend.api import app
from backend.catalog import describe


def test_change_se_uses_temporal_covariance():
    observed = change_se(np.array([10.0]), np.array([10.0]))[0]
    assert observed == pytest.approx(math.sqrt(110))
    assert observed < math.sqrt(200)


def test_shared_error_prevents_false_precision():
    many = np.full(1000, 10.0)
    assert aggregate_se(many, many) > 5.0
    assert aggregate_se(many, many) < 6.0


def test_confidence_threshold_changes_classification():
    assert classification(1.7, 1, Z[90]) == "gain"
    assert classification(1.7, 1, Z[95]) == "uncertain"


def test_raster_analysis_excludes_nodata_and_reconciles_areas():
    result = analyze("algonquin", 2018, 2025, 95)
    summary = result["summary"]
    assert summary["sourcePixelCount"] == 112 * 88 - 16
    assert summary["areaHa"] == pytest.approx(summary["sourcePixelCount"] * 0.09)
    assert sum(summary["classAreaHa"].values()) == pytest.approx(
        summary["areaHa"], abs=0.2
    )
    assert (
        summary["siteInterval"][0] < summary["meanChange"] < summary["siteInterval"][1]
    )
    assert result["provenance"]["resolutionMeters"] == 30
    baseline = next(
        a
        for a in result["decisionAudit"]
        if a["temporalCorrelation"] == 0.45 and a["confidence"] == 95
    )
    assert baseline["classifiedAreaHa"] == pytest.approx(
        summary["classAreaHa"]["gain"] + summary["classAreaHa"]["loss"], abs=0.15
    )


def test_geojson_mask_changes_aggregate():
    site = describe("algonquin")
    south, west = site["bounds"][0]
    north, east = site["bounds"][1]
    mid = (west + east) / 2
    polygon = {
        "type": "Polygon",
        "coordinates": [
            [[west, south], [mid, south], [mid, north], [west, north], [west, south]]
        ],
    }
    full = analyze("algonquin", 2018, 2025, 95)
    clipped = analyze("algonquin", 2018, 2025, 95, polygon)
    assert 0 < clipped["summary"]["areaHa"] < full["summary"]["areaHa"]
    assert clipped["summary"]["sourcePixelCount"] < full["summary"]["sourcePixelCount"]
    assert clipped["summary"]["meanChange"] != full["summary"]["meanChange"]


def test_invalid_polygon_and_years_are_rejected():
    with pytest.raises(AnalysisError):
        analyze("algonquin", 2025, 2018, 95)
    with pytest.raises(AnalysisError):
        analyze("algonquin", 2018, 2025, 95, {"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(AnalysisError):
        analyze(
            "algonquin",
            2018,
            2025,
            95,
            {
                "type": "Polygon",
                "coordinates": [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]],
            },
        )


def test_api_contract_and_error_status():
    client = TestClient(app)
    assert client.get("/api/health").json()["ok"]
    assert len(client.get("/api/sites").json()["sites"]) == 3
    response = client.post(
        "/api/analyze",
        json={"site": "madre", "start": 2019, "end": 2025, "confidence": 90},
    )
    assert response.status_code == 200
    assert response.json()["summary"]["sourcePixelCount"] > 9000
    bad = client.post("/api/analyze", json={"site": "unknown"})
    assert bad.status_code == 400


def test_madre_decision_audit_exposes_assumption_sensitive_verdict():
    result = analyze("madre", 2018, 2025, 95)
    assert result["summary"]["siteDirection"] == "loss"
    independent = next(
        a
        for a in result["decisionAudit"]
        if a["temporalCorrelation"] == 0 and a["confidence"] == 95
    )
    assert independent["siteDirection"] == "uncertain"
