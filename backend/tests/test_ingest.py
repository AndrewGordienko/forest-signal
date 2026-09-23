import json

import pytest

from backend import ingest as module
from backend.catalog import DATA


def test_ingest_registers_valid_aligned_stack(tmp_path, monkeypatch):
    monkeypatch.setattr(module, "DATA", tmp_path / "rasters")
    monkeypatch.setattr(module, "REGISTRY", tmp_path / "registered.json")
    module.ingest("interview_site", "Interview site", "Canada", DATA / "algonquin")
    registered = json.loads((tmp_path / "registered.json").read_text())
    assert registered["interview_site"]["dataKind"] == "imported"
    assert (tmp_path / "rasters" / "interview_site" / "stock_2025.tif").exists()
    with pytest.raises(ValueError, match="already exists"):
        module.ingest("algonquin", "Duplicate", "Canada", DATA / "algonquin")


def test_ingest_rejects_incomplete_stack(tmp_path):
    with pytest.raises(ValueError, match="Missing stock_2018.tif"):
        module.validate_source(tmp_path)
