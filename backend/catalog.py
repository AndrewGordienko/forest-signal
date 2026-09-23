"""Dataset catalog. Add another site by supplying aligned annual stock and SE GeoTIFFs."""

import json
from pathlib import Path

import rasterio
from rasterio.warp import transform_bounds

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "rasters"
YEARS = tuple(range(2018, 2026))
SITES = {
    "algonquin": {
        "name": "Algonquin study area",
        "region": "Ontario, Canada",
        "center": (45.650, -78.430),
        "crs": "EPSG:32617",
        "seed": 1.7,
        "base": 123,
        "trend": 1.25,
        "color": "#bddc88",
        "story": "Mixed forest with a localized disturbance and a broader, modest gain signal.",
    },
    "madre": {
        "name": "Madre de Dios study area",
        "region": "Peru",
        "center": (-12.820, -69.480),
        "crs": "EPSG:32719",
        "seed": 4.1,
        "base": 186,
        "trend": 0.62,
        "color": "#e2bd85",
        "story": "Tropical forest with a clearing corridor and broader degradation.",
    },
    "kalimantan": {
        "name": "Kalimantan study area",
        "region": "Indonesia",
        "center": (0.360, 115.360),
        "crs": "EPSG:32650",
        "seed": 8.3,
        "base": 211,
        "trend": 0.88,
        "color": "#91c8bb",
        "story": "Tropical forest with patchy loss alongside broad recovery.",
    },
}
SAMPLE_IDS = ("algonquin", "madre", "kalimantan")
REGISTRY = ROOT / "data" / "registered.json"
if REGISTRY.exists():
    SITES.update(json.loads(REGISTRY.read_text()))
WIDTH, HEIGHT, RESOLUTION = 112, 88, 30  # metres, pixels; 30 m source raster


def raster_path(site: str, year: int, kind: str) -> Path:
    return DATA / site / f"{kind}_{year}.tif"


def describe(site_id: str) -> dict:
    site = SITES[site_id]
    with rasterio.open(raster_path(site_id, YEARS[0], "stock")) as src:
        west, south, east, north = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        resolution = round(abs(src.transform.a))
    lat, lon = site["center"]
    return {
        "id": site_id,
        "name": site["name"],
        "region": site["region"],
        "center": [lat, lon],
        "bounds": [[south, west], [north, east]],
        "color": site["color"],
        "story": site["story"],
        "resolutionMeters": resolution,
        "years": list(YEARS),
        "dataKind": site.get("dataKind", "synthetic"),
    }
