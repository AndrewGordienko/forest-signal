"""Validate every raster in the catalog before serving it."""

import numpy as np

from .analysis import AnalysisError, read_pair, validate_alignment
from .catalog import SITES, YEARS


def validate():
    for site in SITES:
        validate_alignment(site, YEARS[0], YEARS[-1])
        for year in YEARS:
            stock, se, _ = read_pair(site, year)
            valid = ~(np.ma.getmaskarray(stock) | np.ma.getmaskarray(se))
            if not np.any(valid):
                raise AnalysisError(f"{site} {year}: no valid pixels")
            if not np.all(np.isfinite(stock.data[valid])) or not np.all(
                np.isfinite(se.data[valid])
            ):
                raise AnalysisError(f"{site} {year}: non-finite values")
            if np.any(stock.data[valid] < 0) or np.any(se.data[valid] <= 0):
                raise AnalysisError(f"{site} {year}: out-of-range values")
        print(f"{site}: {len(YEARS)} aligned annual stock/SE pairs OK")


if __name__ == "__main__":
    validate()
