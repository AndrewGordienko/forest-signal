"""Register an aligned 2018–2025 annual stock/SE GeoTIFF stack.

Usage: python -m backend.ingest --site-id my-site --name 'My Site' --region 'Ontario'
       --source-dir /path/to/rasters
"""

import argparse
import json
import re
import shutil
import tempfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform_bounds

from .catalog import DATA, REGISTRY, SITES, YEARS


def validate_source(source: Path):
    reference = None
    for year in YEARS:
        for kind in ("stock", "se"):
            path = source / f"{kind}_{year}.tif"
            if not path.exists():
                raise ValueError(f"Missing {path.name}")
            with rasterio.open(path) as src:
                if src.count != 1 or src.crs is None or src.nodata is None:
                    raise ValueError(f"{path.name}: expected one band, CRS, and nodata")
                if (
                    not src.crs.is_projected
                    or src.crs.linear_units_factor[1] != 1.0
                    or abs(src.transform.a - src.transform.e * -1) > 1e-6
                ):
                    raise ValueError(
                        f"{path.name}: expected a projected, square-pixel grid"
                    )
                identity = (src.width, src.height, src.crs, src.transform)
                if reference and identity != reference:
                    raise ValueError(
                        f"{path.name}: grid does not match the first raster"
                    )
                reference = identity
                array = src.read(1, masked=True)
                values = array.compressed()
                if not len(values) or not np.all(np.isfinite(values)):
                    raise ValueError(f"{path.name}: no finite data")
                if np.any(values < 0) or kind == "se" and np.any(values <= 0):
                    raise ValueError(
                        f"{path.name}: stock must be nonnegative and SE positive"
                    )
    return reference


def ingest(site_id: str, name: str, region: str, source: Path):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,39}", site_id):
        raise ValueError(
            "site-id must be 2–40 lowercase letters, numbers, dashes, or underscores"
        )
    if site_id in SITES:
        raise ValueError("Site ID already exists")
    source = source.expanduser().resolve()
    width, height, crs, transform = validate_source(source)
    left, top = transform @ (0, 0)
    right, bottom = transform @ (width, height)
    west, south, east, north = transform_bounds(
        crs, "EPSG:4326", left, bottom, right, top
    )
    target = DATA / site_id
    if target.exists():
        raise ValueError("Target folder already exists")
    # Validate first, then stage all files before publishing the directory.
    DATA.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ingest-", dir=DATA) as temp:
        staging = Path(temp)
        for year in YEARS:
            for kind in ("stock", "se"):
                shutil.copy2(
                    source / f"{kind}_{year}.tif", staging / f"{kind}_{year}.tif"
                )
        shutil.move(str(staging), str(target))
    registered = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else {}
    registered[site_id] = {
        "name": name,
        "region": region,
        "center": [(south + north) / 2, (west + east) / 2],
        "crs": str(crs),
        "color": "#a7c7aa",
        "story": "Imported annual biomass stock and uncertainty rasters.",
        "dataKind": "imported",
    }
    REGISTRY.write_text(json.dumps(registered, indent=2) + "\n")
    print(f"Registered {site_id}; restart the API to load it.")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--site-id", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--region", required=True)
    p.add_argument("--source-dir", type=Path, required=True)
    a = p.parse_args()
    ingest(a.site_id, a.name, a.region, a.source_dir)
