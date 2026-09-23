#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  if command -v uv >/dev/null 2>&1; then uv venv --python 3.12 .venv; else python3.12 -m venv .venv; fi
fi
if ! .venv/bin/python -c 'import rasterio, fastapi, uvicorn' >/dev/null 2>&1; then
  if command -v uv >/dev/null 2>&1; then uv pip install --python .venv/bin/python -e '.[dev]'; else .venv/bin/python -m pip install -e '.[dev]'; fi
fi
if [ ! -d node_modules ]; then npm ci; fi
if [ ! -f data/rasters/algonquin/stock_2018.tif ]; then .venv/bin/python -m backend.generate_sample; fi
.venv/bin/python -m backend.validate
.venv/bin/uvicorn backend.api:app --host 127.0.0.1 --port 8014 &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true' EXIT
npm run dev -- --host 127.0.0.1
