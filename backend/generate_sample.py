"""Rebuild reproducible synthetic GeoTIFF fixtures at actual 30 metre resolution."""

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_origin

from .catalog import (
    DATA,
    HEIGHT,
    RESOLUTION,
    SAMPLE_IDS,
    SITES,
    WIDTH,
    YEARS,
    raster_path,
)


def gaussian(x, y, cx, cy, sx, sy):
    return np.exp(-0.5 * (((x - cx) / sx) ** 2 + ((y - cy) / sy) ** 2))


def generate():
    yy, xx = np.mgrid[:HEIGHT, :WIDTH]
    x, y = (xx + 0.5) / WIDTH, (yy + 0.5) / HEIGHT
    for key in SAMPLE_IDS:
        site = SITES[key]
        lat, lon = site["center"]
        east, north = Transformer.from_crs(
            "EPSG:4326", site["crs"], always_xy=True
        ).transform(lon, lat)
        transform = from_origin(
            east - WIDTH * RESOLUTION / 2,
            north + HEIGHT * RESOLUTION / 2,
            RESOLUTION,
            RESOLUTION,
        )
        seed = site["seed"]
        texture = 12 * np.sin(12 * x + seed) * np.cos(9 * y - seed) + 7 * np.sin(
            28 * x + 15 * y + seed
        )
        baseline = site["base"] + texture + 18 * y - 8 * x
        se = (
            8.3
            + 5.5 * np.abs(np.sin(7 * x + 3 * y + seed))
            + 4 * gaussian(x, y, 0.72, 0.33, 0.15, 0.20)
        )
        # A small nodata patch tests mask propagation.
        valid = np.ones((HEIGHT, WIDTH), dtype=bool)
        valid[5:9, 8:12] = False
        for year in YEARS:
            trend = (year - 2018) * (site["trend"] + 0.45 * np.sin(5 * x + seed))
            if key == "algonquin":
                disturbance = (
                    -58
                    * gaussian(x, y, 0.69, 0.40, 0.12, 0.16)
                    * np.clip((year - 2020) / 3, 0, 1)
                )
                recovery = (
                    16
                    * gaussian(x, y, 0.23, 0.68, 0.17, 0.14)
                    * np.clip((year - 2019) / 6, 0, 1)
                )
            elif key == "madre":
                corridor = np.exp(-(((y - (0.22 + 0.56 * x)) / 0.09) ** 2))
                disturbance = (
                    -68 * corridor * gaussian(x, y, 0.59, 0.54, 0.25, 0.33)
                    - 28 * gaussian(x, y, 0.5, 0.5, 0.38, 0.35)
                ) * np.clip((year - 2019) / 5, 0, 1)
                recovery = (
                    8
                    * gaussian(x, y, 0.18, 0.73, 0.16, 0.17)
                    * np.clip((year - 2021) / 4, 0, 1)
                )
            else:
                disturbance = (
                    -52
                    * gaussian(x, y, 0.35, 0.59, 0.14, 0.13)
                    * np.clip((year - 2020) / 4, 0, 1)
                )
                disturbance -= (
                    34
                    * gaussian(x, y, 0.74, 0.30, 0.13, 0.12)
                    * np.clip((year - 2022) / 3, 0, 1)
                )
                recovery = (
                    26 * gaussian(x, y, 0.79, 0.79, 0.15, 0.15)
                    + 30 * gaussian(x, y, 0.5, 0.5, 0.45, 0.4)
                ) * np.clip((year - 2018) / 7, 0, 1)
            stock = np.maximum(
                0,
                baseline
                + trend
                + disturbance
                + recovery
                + 2.1 * np.sin(year * 1.31 + 16 * x + 7 * y + seed),
            )
            profile = {
                "driver": "GTiff",
                "height": HEIGHT,
                "width": WIDTH,
                "count": 1,
                "dtype": "float32",
                "crs": site["crs"],
                "transform": transform,
                "nodata": -9999.0,
                "compress": "deflate",
                "tiled": True,
                "blockxsize": 32,
                "blockysize": 32,
            }
            for kind, values in [("stock", stock), ("se", se)]:
                path = raster_path(key, year, kind)
                path.parent.mkdir(parents=True, exist_ok=True)
                with rasterio.open(path, "w", **profile) as dst:
                    dst.write(np.where(valid, values, -9999).astype("float32"), 1)
    print(f"Wrote sample GeoTIFFs to {DATA}")


if __name__ == "__main__":
    generate()
