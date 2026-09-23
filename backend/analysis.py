"""Raster-backed, uncertainty-aware change analysis.

Input contract: aligned single-band GeoTIFFs per year: stock in t/ha and its
standard error in t/ha. A source may replace the sample files if CRS, shape,
transform, nodata, and units satisfy this contract.
"""

import math
from functools import lru_cache

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask
from shapely.geometry import mapping, shape
from shapely.ops import transform as transform_geometry

from .catalog import SITES, YEARS, raster_path

TEMPORAL_RHO = 0.45
SPATIAL_SHARED = 0.28
Z = {80: 1.2815515655, 90: 1.6448536269, 95: 1.9599639845}
BLOCK = 4


class AnalysisError(ValueError):
    pass


@lru_cache(maxsize=64)
def read_pair(site_id: str, year: int):
    arrays = []
    profile = None
    for kind in ("stock", "se"):
        path = raster_path(site_id, year, kind)
        if not path.exists():
            raise AnalysisError(
                f"Missing raster: {path.name}. Run the sample-data generator or provide a complete dataset."
            )
        with rasterio.open(path) as src:
            if src.count != 1 or src.crs is None or src.nodata is None:
                raise AnalysisError(f"Invalid raster metadata: {path.name}")
            identity = (src.width, src.height, src.crs, src.transform)
            if profile is not None and identity != profile:
                raise AnalysisError(f"Misaligned stock and SE rasters for {year}.")
            profile = identity
            arrays.append(src.read(1, masked=True).astype("float64"))
    stock, se = arrays
    if np.any(stock.compressed() < 0) or np.any(se.compressed() <= 0):
        raise AnalysisError("Stock must be nonnegative and SE positive.")
    return stock, se, profile


def validate_alignment(site_id: str, start: int, end: int):
    _, _, reference = read_pair(site_id, start)
    for year in range(start + 1, end + 1):
        if read_pair(site_id, year)[2] != reference:
            raise AnalysisError(f"Raster {year} is not aligned to {start}.")
    return reference


def make_mask(geometry: dict | None, profile):
    width, height, crs, affine = profile
    if geometry is None:
        return np.ones((height, width), dtype=bool)
    try:
        if geometry.get("type") == "Feature":
            geometry = geometry["geometry"]
        if geometry.get("type") != "Polygon":
            raise AnalysisError("Upload a GeoJSON Polygon.")
        polygon = shape(geometry)
        if not polygon.is_valid or polygon.is_empty or polygon.area <= 0:
            raise AnalysisError("Invalid polygon geometry.")
        if len(polygon.exterior.coords) > 10000:
            raise AnalysisError("Polygon has too many vertices.")
        if not all(
            -180 <= x <= 180 and -90 <= y <= 90 for x, y in polygon.exterior.coords
        ):
            raise AnalysisError(
                "Polygon coordinates must be WGS84 longitude and latitude."
            )
        projector = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        projected = transform_geometry(projector.transform, polygon)
        return geometry_mask(
            [mapping(projected)],
            out_shape=(height, width),
            transform=affine,
            invert=True,
            all_touched=False,
        )
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, AnalysisError):
            raise
        raise AnalysisError(f"Invalid polygon: {exc}") from exc


def change_se(se_a, se_b, rho=TEMPORAL_RHO):
    return np.sqrt(np.maximum(0, se_a**2 + se_b**2 - 2 * rho * se_a * se_b))


def aggregate_se(se_a, se_b, rho=TEMPORAL_RHO):
    """SE of a mean using a shared spatial component and paired temporal errors."""
    n = len(se_a)
    var_a = (
        SPATIAL_SHARED * float(np.mean(se_a)) ** 2
        + (1 - SPATIAL_SHARED) * float(np.sum(se_a**2)) / n**2
    )
    var_b = (
        SPATIAL_SHARED * float(np.mean(se_b)) ** 2
        + (1 - SPATIAL_SHARED) * float(np.sum(se_b**2)) / n**2
    )
    return math.sqrt(max(0, var_a + var_b - 2 * rho * math.sqrt(var_a * var_b)))


def classification(delta, se, z):
    score = delta / se
    return "gain" if score > z else "loss" if score < -z else "uncertain"


def analyze(
    site_id: str, start: int, end: int, confidence: int, geometry: dict | None = None
):
    if site_id not in SITES:
        raise AnalysisError("Unknown study area.")
    if start not in YEARS or end not in YEARS or start >= end:
        raise AnalysisError("Choose ordered years from 2018 through 2025.")
    if confidence not in Z:
        raise AnalysisError("Confidence must be 80, 90, or 95 percent.")
    profile = validate_alignment(site_id, start, end)
    width, height, crs, affine = profile
    stock_a, se_a, _ = read_pair(site_id, start)
    stock_b, se_b, _ = read_pair(site_id, end)
    selected = make_mask(geometry, profile)
    valid = (
        selected
        & ~np.ma.getmaskarray(stock_a)
        & ~np.ma.getmaskarray(stock_b)
        & ~np.ma.getmaskarray(se_a)
        & ~np.ma.getmaskarray(se_b)
    )
    if not np.any(valid):
        raise AnalysisError(
            "The polygon does not contain any valid pixels in this study area."
        )
    a = np.asarray(stock_a.data)[valid]
    b = np.asarray(stock_b.data)[valid]
    sa = np.asarray(se_a.data)[valid]
    sb = np.asarray(se_b.data)[valid]
    delta = b - a
    mean_change = float(np.mean(delta))
    site_se = aggregate_se(sa, sb)
    z = Z[confidence]
    area_per_pixel_ha = abs(affine.a * affine.e) / 10000
    # Mean trajectory is computed from the same raster stack and exact AOI mask.
    series = []
    for year in YEARS:
        stock, year_se, _ = read_pair(site_id, year)
        year_valid = (
            selected & ~np.ma.getmaskarray(stock) & ~np.ma.getmaskarray(year_se)
        )
        values = np.asarray(stock.data)[year_valid]
        series.append(
            {
                "year": year,
                "stock": round(float(np.mean(values)), 1) if len(values) else None,
            }
        )
    # Display cells summarize 4x4 source pixels. All statistics above use the full 30 m grid.
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    cells = []
    block_samples = []
    class_area = {"gain": 0.0, "loss": 0.0, "uncertain": 0.0}
    for row in range(0, height, BLOCK):
        for col in range(0, width, BLOCK):
            sl = (
                slice(row, min(row + BLOCK, height)),
                slice(col, min(col + BLOCK, width)),
            )
            block_valid = valid[sl]
            if not np.any(block_valid):
                continue
            block_a = np.asarray(stock_a.data)[sl][block_valid]
            block_b = np.asarray(stock_b.data)[sl][block_valid]
            block_sa = np.asarray(se_a.data)[sl][block_valid]
            block_sb = np.asarray(se_b.data)[sl][block_valid]
            block_delta = float(np.mean(block_b - block_a))
            block_se = aggregate_se(block_sa, block_sb)
            kind = classification(block_delta, block_se, z)
            block_area = int(np.sum(block_valid)) * area_per_pixel_ha
            class_area[kind] += block_area
            block_samples.append((block_delta, block_sa, block_sb, block_area))
            left, top = affine @ (col, row)
            right, bottom = affine @ (min(col + BLOCK, width), min(row + BLOCK, height))
            west, north = to_wgs84.transform(left, top)
            east, south = to_wgs84.transform(right, bottom)
            mid_lon, mid_lat = to_wgs84.transform(
                (left + right) / 2, (top + bottom) / 2
            )
            cells.append(
                {
                    "id": f"{row // BLOCK}-{col // BLOCK}",
                    "lat": round(mid_lat, 6),
                    "lon": round(mid_lon, 6),
                    "bounds": [[south, west], [north, east]],
                    "areaHa": round(block_area, 3),
                    "startStock": round(float(np.mean(block_a)), 2),
                    "endStock": round(float(np.mean(block_b)), 2),
                    "delta": round(block_delta, 2),
                    "changeSe": round(block_se, 2),
                    "score": round(block_delta / block_se, 2),
                    "classification": kind,
                    "sourcePixels": int(np.sum(block_valid)),
                }
            )
    interval = [mean_change - z * site_se, mean_change + z * site_se]
    direction = classification(mean_change, site_se, z)
    # Reclassify the same display blocks that underpin the map and headline.
    audit = []
    for assumed_rho in (0.0, 0.45, 0.8):
        scenario_se = aggregate_se(sa, sb, assumed_rho)
        for level, threshold in Z.items():
            classified_area = sum(
                block_area
                for block_delta, block_sa, block_sb, block_area in block_samples
                if classification(
                    block_delta,
                    aggregate_se(block_sa, block_sb, assumed_rho),
                    threshold,
                )
                != "uncertain"
            )
            audit.append(
                {
                    "temporalCorrelation": assumed_rho,
                    "confidence": level,
                    "siteDirection": classification(
                        mean_change, scenario_se, threshold
                    ),
                    "classifiedAreaHa": round(classified_area, 1),
                    "interval": [
                        round(mean_change - threshold * scenario_se, 2),
                        round(mean_change + threshold * scenario_se, 2),
                    ],
                }
            )
    return {
        "site": site_id,
        "start": start,
        "end": end,
        "confidence": confidence,
        "cells": cells,
        "series": series,
        "decisionAudit": audit,
        "summary": {
            "areaHa": round(int(np.sum(valid)) * area_per_pixel_ha, 1),
            "meanChange": round(mean_change, 2),
            "siteInterval": [round(v, 2) for v in interval],
            "siteDirection": direction,
            "classAreaHa": {k: round(v, 1) for k, v in class_area.items()},
            "cellCount": len(cells),
            "sourcePixelCount": int(np.sum(valid)),
        },
        "provenance": {
            "kind": SITES[site_id].get("dataKind", "synthetic") + "-geotiff",
            "resolutionMeters": round(abs(affine.a)),
            "units": "t/ha",
            "temporalCorrelation": TEMPORAL_RHO,
            "spatialSharedVariance": SPATIAL_SHARED,
            "methodVersion": "1.0.0",
        },
    }
