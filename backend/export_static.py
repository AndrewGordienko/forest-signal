"""Export compact raster-derived fixtures for the GitHub Pages interactive preview."""

import json

import numpy as np
from pyproj import Transformer

from .analysis import BLOCK, read_pair
from .catalog import ROOT, SAMPLE_IDS, YEARS, describe

OUT = ROOT / "public" / "demo-data"


def export():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sites.json").write_text(
        json.dumps(
            {"sites": [describe(key) for key in SAMPLE_IDS]}, separators=(",", ":")
        )
    )
    for site_id in SAMPLE_IDS:
        stock0, se, profile = read_pair(site_id, YEARS[0])
        width, height, crs, affine = profile
        to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        rows, cols = np.indices((height, width))
        xs = affine.c + (cols + 0.5) * affine.a
        ys = affine.f + (rows + 0.5) * affine.e
        lon, lat = to_wgs84.transform(xs, ys)
        valid = ~np.ma.getmaskarray(stock0)
        block_bounds = {}
        for row in range(0, height, BLOCK):
            for col in range(0, width, BLOCK):
                left, top = affine @ (col, row)
                right, bottom = affine @ (
                    min(col + BLOCK, width),
                    min(row + BLOCK, height),
                )
                west, north = to_wgs84.transform(left, top)
                east, south = to_wgs84.transform(right, bottom)
                block_bounds[f"{row // BLOCK}-{col // BLOCK}"] = [
                    [south, west],
                    [north, east],
                ]
        stocks = {}
        for year in YEARS:
            stock, _, _ = read_pair(site_id, year)
            stocks[str(year)] = [
                round(float(v), 4) if mask else None
                for v, mask in zip(stock.data.flat, valid.flat)
            ]
        payload = {
            "width": width,
            "height": height,
            "pixelAreaHa": abs(affine.a * affine.e) / 10000,
            "lon": [round(float(v), 7) for v in lon.flat],
            "lat": [round(float(v), 7) for v in lat.flat],
            "se": [
                round(float(v), 4) if mask else None
                for v, mask in zip(se.data.flat, valid.flat)
            ],
            "stock": stocks,
            "blockBounds": block_bounds,
        }
        path = OUT / f"{site_id}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")))
        print(site_id, round(path.stat().st_size / 1e6, 2), "MB")
    from .analysis import analyze

    parity = []
    for site_id in SAMPLE_IDS:
        for level in (80, 90, 95):
            result = analyze(site_id, 2018, 2025, level)
            parity.append(
                {
                    "input": {
                        "site": site_id,
                        "start": 2018,
                        "end": 2025,
                        "confidence": level,
                        "polygon": None,
                    },
                    "summary": result["summary"],
                }
            )
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
    clipped = analyze("algonquin", 2018, 2025, 95, polygon)
    parity.append(
        {
            "input": {
                "site": "algonquin",
                "start": 2018,
                "end": 2025,
                "confidence": 95,
                "polygon": polygon,
            },
            "summary": clipped["summary"],
        }
    )
    (OUT / "parity.json").write_text(json.dumps(parity, separators=(",", ":")))


if __name__ == "__main__":
    export()
