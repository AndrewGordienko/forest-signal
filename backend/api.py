"""HTTP layer for the raster change analysis."""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .analysis import AnalysisError, analyze
from .catalog import SITES, describe

app = FastAPI(
    title="Forest Signal API",
    version="1.0.0",
    description="Raster-backed forest change demonstration",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5174", "http://localhost:5174"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class AnalysisRequest(BaseModel):
    site: str = "algonquin"
    start: int = Field(default=2018, ge=2018, le=2025)
    end: int = Field(default=2025, ge=2018, le=2025)
    confidence: int = 95
    polygon: dict | None = None


@app.get("/api/health")
def health():
    return {"ok": True, "version": "1.0.0"}


@app.get("/api/sites")
def sites():
    return {"sites": [describe(key) for key in SITES]}


@app.post("/api/analyze")
def analysis(request: AnalysisRequest):
    try:
        return analyze(
            request.site,
            request.start,
            request.end,
            request.confidence,
            request.polygon,
        )
    except AnalysisError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# A production build is served by the same process as the API. Vite proxies /api in development.
from pathlib import Path

from fastapi.staticfiles import StaticFiles

_dist = Path(__file__).resolve().parents[1] / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
