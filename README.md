# Forest Signal

**Live demo:** https://andrewgordienko.github.io/forest-signal/ · **Source:** https://github.com/AndrewGordienko/forest-signal

A geospatial case study and analysis service built as an independent interview project by Andrew Gordienko. Its thesis: **a biomass change estimate becomes useful when a reviewer can see whether it supports a decision, where that support comes from, and which assumptions could reverse it.** The article leads a reader through the estimate, the spatial evidence, and a nine-scenario decision check. Its figures run on a reproducible raster workflow and API.

**The bundled study areas are synthetic.** Their 30 m GeoTIFFs exist to exercise the pipeline. No displayed biomass estimate is a Chloris observation, and the illustrative covariance settings are not calibrated for carbon accounting.

## Show it locally

Requires Node 22+, Python 3.12, and either [uv](https://docs.astral.sh/uv/) or a working `python3.12 -m venv`. From this folder:

```bash
./run.sh
```

Open **http://127.0.0.1:5174**. The API is at **http://127.0.0.1:8014/docs**. Other demos in the parent folder use separate ports.

For a single-process production preview:

```bash
npm ci && npm run build
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/uvicorn backend.api:app --host 127.0.0.1 --port 8014
```

Open **http://127.0.0.1:8014**. Docker is also supported: `docker build -t forest-signal . && docker run --rm -p 8014:8014 forest-signal`.

## Five-minute review path

1. Start on Madre de Dios, 2018 → 2025, 95% confidence. The area-wide interval supports net loss under the baseline error assumption.
2. In the map, switch between **Raw difference** and **After uncertainty**. Click a block to inspect its estimate and standard error.
3. In the decision check, select **Independent / 95%**. The same mean change becomes inconclusive when the paired-error assumption changes.
4. Switch to Algonquin, where local gain and loss coexist with an inconclusive area-wide verdict. Switch to Kalimantan, where net gain survives all nine settings.
5. Upload a GeoJSON Polygon within a sample landscape. The API masks the 30 m rasters and recomputes statistics; the cell CSV exports the result.

## What is engineered here

- **Raster inputs:** annual single-band stock and SE GeoTIFF pairs, in t/ha, read with Rasterio. The bundled data contains 8 years × 2 products × 3 areas. A validator checks CRS, pixel grid, nodata, finite values, and valid ranges.
- **AOI processing:** a WGS84 GeoJSON polygon is transformed to the raster CRS and rasterized as a center-of-pixel mask. The exact 30 m source pixels determine the area mean and time series; 4 × 4 blocks are produced only for map display and inspection.
- **Error propagation:** for paired years, `Var(change) = SE₁² + SE₂² − 2ρ SE₁ SE₂`. The sample model uses ρ = 0.45. Site aggregation includes a 28% shared regional error component, avoiding the false precision that would result from treating neighboring pixels as independent.
- **Decision audit:** the same source pixels are reclassified at 80%, 90%, and 95% thresholds under ρ ∈ {0, 0.45, 0.8}. This exposes conclusions that depend on an assumption.
- **Delivery:** typed request validation, JSON API, responsive map and chart, GeoJSON AOI import, CSV export, data provenance, a production static build, and automated tests.

The covariance numbers and normal thresholds demonstrate a method; they are not fitted to an actual sensor or validated against reference plots. A real deployment would replace the fixtures, calibrate the joint error model, test spatial autocorrelation, evaluate on independent field/LiDAR references, and review statistical coverage by ecosystem and disturbance type.

## Bring your own raster stack

Prepare `stock_2018.tif` … `stock_2025.tif` and `se_2018.tif` … `se_2025.tif` in one directory. Each file needs one band, nodata, a projected metre-based CRS, square pixels, identical width/height/transform/CRS, stock in **t/ha**, and standard error in **t/ha**. Stock must be nonnegative and SE positive. The importer validates these structural and numeric conditions but cannot independently verify the meaning of the units.

```bash
.venv/bin/python -m backend.ingest \
  --site-id my-site --name 'My study area' --region 'Ontario, Canada' \
  --source-dir /absolute/path/to/rasters
```

Restart the API. The site appears in the selector as **Imported rasters**. The importer stages all files before publishing the dataset directory and rejects an incomplete or misaligned stack.

## Reproduce and verify

```bash
.venv/bin/python -m backend.generate_sample  # rebuild deterministic fixtures
.venv/bin/python -m backend.validate
.venv/bin/python -m backend.export_static
.venv/bin/python -m pytest -q
npm run test:static
npm run build
```

The tests cover paired covariance, spatially shared uncertainty, classification thresholds, nodata handling, area reconciliation, polygon clipping, and API errors. The GitHub Pages preview replays the same calculations in the browser from GeoTIFF-derived JSON exports; `npm run test:static` checks its summaries against the Python pipeline. Only the three synthetic fixture sites are exported. The Python API and raster importer run in the local/Docker build.

The sample data is intentionally small (about 1.7 MB on disk), so the project runs without cloud credentials or a remote data dependency. Satellite basemap tiles and Google Fonts need internet; the raster analysis itself is local.

## Relevance to Chloris

Chloris publicly describes annual above-ground biomass stock, change, pixel-level uncertainty, forest cover/change, and tools for screening and portfolio monitoring. Its geospatial backend role calls for bringing data-science code into production and working with Python and geospatial tools. This prototype focuses on that engineering boundary: validated rasters → uncertainty-aware calculation → area summaries and reviewable outputs. It is complementary to their product, not a copy of their proprietary model or UI.

- [Chloris data products](https://www.chloris.earth/data)
- [Chloris screening and monitoring tools](https://www.chloris.earth/screening-and-monitoring)
- [Chloris platform user guide](https://app.chloris.earth/docs/1.9.0/user-guide.html)
- [Geospatial Software Engineer (Backend) job listing](https://chloris.bamboohr.com/careers/58)
