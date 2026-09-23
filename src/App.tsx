import { useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  Polygon,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
  ZoomControl,
} from "react-leaflet";
import TrendChart from "./TrendChart";
import { analyzeStatic, loadStaticSites, STATIC_MODE } from "./staticAnalysis";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Download,
  FileJson,
  Layers3,
  MapPin,
  RotateCcw,
  Satellite,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import type { LatLngExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

type Class = "gain" | "loss" | "uncertain";
type Layer = "signal" | "raw" | "uncertainty";
type Site = {
  id: string;
  name: string;
  region: string;
  center: [number, number];
  bounds: [[number, number], [number, number]];
  color: string;
  story: string;
  dataKind?: "synthetic" | "imported";
};
type Cell = {
  id: string;
  lat: number;
  lon: number;
  bounds: [[number, number], [number, number]];
  areaHa: number;
  startStock: number;
  endStock: number;
  delta: number;
  changeSe: number;
  score: number;
  classification: Class;
};
type Result = {
  decisionAudit: {
    temporalCorrelation: number;
    confidence: number;
    siteDirection: Class;
    classifiedAreaHa: number;
    interval: [number, number];
  }[];
  site: string;
  start: number;
  end: number;
  confidence: number;
  cells: Cell[];
  series: { year: number; stock: number }[];
  summary: {
    areaHa: number;
    meanChange: number;
    siteInterval: [number, number];
    siteDirection: Class;
    classAreaHa: Record<Class, number>;
    cellCount: number;
    sourcePixelCount: number;
  };
};
const defaults: Site[] = [
  {
    id: "algonquin",
    name: "Algonquin landscape",
    region: "Ontario, Canada",
    center: [45.65, -78.43],
    bounds: [
      [45.52, -78.65],
      [45.79, -78.2],
    ],
    color: "#bddc88",
    story:
      "Mixed forest with a localized disturbance and a broader, modest gain signal.",
  },
  {
    id: "madre",
    name: "Madre de Dios landscape",
    region: "Peru",
    center: [-12.82, -69.48],
    bounds: [
      [-12.98, -69.7],
      [-12.66, -69.26],
    ],
    color: "#e2bd85",
    story: "Tropical forest with a clearing corridor and broader degradation.",
  },
  {
    id: "kalimantan",
    name: "Kalimantan landscape",
    region: "Indonesia",
    center: [0.36, 115.36],
    bounds: [
      [0.2, 115.16],
      [0.52, 115.56],
    ],
    color: "#91c8bb",
    story: "Tropical forest with patchy loss alongside broad recovery.",
  },
];
const fmt = (n: number, d = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const sign = (n: number, d = 1) => (n > 0 ? "+" : "") + fmt(n, d);
function FlyTo({ site }: { site: Site }) {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(site.bounds, { padding: [35, 35], animate: true });
  }, [map, site]);
  return null;
}
function cellColor(c: Cell, l: Layer) {
  if (l === "signal")
    return c.classification === "gain"
      ? "#9ed478"
      : c.classification === "loss"
        ? "#f17e66"
        : "#efdeb2";
  if (l === "uncertainty")
    return c.changeSe > 18
      ? "#e97b65"
      : c.changeSe > 15
        ? "#eabf80"
        : "#a5d8ab";
  return c.delta < -32
    ? "#dc6e62"
    : c.delta < -12
      ? "#eaa48a"
      : c.delta < 4
        ? "#eee0b8"
        : c.delta < 18
          ? "#bfdb91"
          : "#78bda3";
}
function download(result: Result) {
  const lines = [
    "cell_id,lat,lon,area_ha,start_t_ha,end_t_ha,change_t_ha,change_se_t_ha,z_score,class",
    ...result.cells.map((c) =>
      [
        c.id,
        c.lat,
        c.lon,
        c.areaHa.toFixed(2),
        c.startStock,
        c.endStock,
        c.delta,
        c.changeSe,
        c.score,
        c.classification,
      ].join(","),
    ),
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join("\n")], { type: "text/csv" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "forest-signal-" + result.site + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}
export default function App() {
  const [sites, setSites] = useState(defaults),
    [siteId, setSiteId] = useState("algonquin"),
    [start, setStart] = useState(2018),
    [end, setEnd] = useState(2025),
    [confidence, setConfidence] = useState(95);
  const [layer, setLayer] = useState<Layer>("signal"),
    [base, setBase] = useState<"satellite" | "street">("satellite"),
    [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [polygon, setPolygon] = useState<object | null>(null),
    [polygonName, setPolygonName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notes, setNotes] = useState(false);
  const file = useRef<HTMLInputElement>(null),
    seq = useRef(0);
  const site = sites.find((s) => s.id === siteId) || sites[0],
    cell = useMemo(
      () => result?.cells.find((c) => c.id === selected),
      [result, selected],
    );
  useEffect(() => {
    (STATIC_MODE
      ? loadStaticSites()
      : fetch("/api/sites")
          .then((r) => r.json())
          .then((d) => d.sites)
    )
      .then((d) => {
        if (Array.isArray(d)) setSites(d);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      return (
        STATIC_MODE
          ? analyzeStatic({ site: siteId, start, end, confidence, polygon })
          : fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                site: siteId,
                start,
                end,
                confidence,
                polygon,
              }),
            }).then(async (r) => {
              const d = await r.json();
              if (!r.ok) throw Error(d.detail || d.error || "Analysis failed");
              return d as Result;
            })
      )
        .then((d) => {
          if (id === seq.current) {
            setResult(d as Result);
            setSelected(null);
          }
        })
        .catch((e) => {
          if (id === seq.current) setError(e.message);
        })
        .finally(() => {
          if (id === seq.current) setBusy(false);
        });
    }, 100);
    return () => clearTimeout(timer);
  }, [siteId, start, end, confidence, polygon]);
  const changeSite = (id: string) => {
    setSiteId(id);
    setPolygon(null);
    setPolygonName("");
  };
  const reset = () => {
    setStart(2018);
    setEnd(2025);
    setConfidence(95);
    setLayer("signal");
    setPolygon(null);
    setPolygonName("");
  };
  const upload = async (f?: File) => {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      const x =
        j.type === "FeatureCollection"
          ? j.features?.[0]?.geometry
          : j.type === "Feature"
            ? j.geometry
            : j;
      if (x?.type !== "Polygon") throw Error("Choose a GeoJSON Polygon.");
      setPolygon(x);
      setPolygonName(f.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read GeoJSON");
    }
  };
  const boundary = polygon
    ? (polygon as { coordinates: number[][][] }).coordinates?.[0]?.map(
        (p) => [p[1], p[0]] as [number, number],
      )
    : null;
  const auditAgree =
    result?.decisionAudit.filter(
      (a) => a.siteDirection === result.summary.siteDirection,
    ).length ?? 0;
  const auditAreas = result?.decisionAudit.map((a) => a.classifiedAreaHa) ?? [];
  const classified = result
    ? result.summary.classAreaHa.gain + result.summary.classAreaHa.loss
    : 0;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>fieldnote</strong>
            <small>GEOSPATIAL LAB</small>
          </div>
        </div>
        <div className="side-block">
          <div className="side-label">WORKSPACE</div>
          <button className="side-link active">
            <Activity size={17} /> Change analysis <i />
          </button>
          <button
            className="side-link"
            onClick={() =>
              document
                .getElementById("landscapes")
                ?.scrollIntoView({ behavior: "smooth" })
            }
          >
            <Layers3 size={17} /> Landscapes
          </button>
          <button className="side-link" onClick={() => setNotes(true)}>
            <CircleHelp size={17} /> Method notes
          </button>
        </div>
        <div className="side-block" id="landscapes">
          <div className="side-label">SAMPLE LANDSCAPES</div>
          {sites.map((s) => (
            <button
              className={"site-link " + (siteId === s.id ? "selected" : "")}
              key={s.id}
              onClick={() => changeSite(s.id)}
            >
              <span className="site-swatch" style={{ background: s.color }} />
              <span>
                <strong>{s.name}</strong>
                <small>{s.region}</small>
              </span>
              {siteId === s.id && <ArrowRight size={14} />}
            </button>
          ))}
        </div>
        <div className="side-bottom">
          <div>
            <i /> SAMPLE DATASET <span>v1.0</span>
          </div>
          <p>
            Independent portfolio demo by Andrew Gordienko. Not affiliated with
            Chloris.
          </p>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="crumbs">
            Workspace <span>/</span> Analysis <span>/</span> <b>{site.name}</b>
          </div>
          <div className="top-right">
            <span className="data-pill">
              <i />{" "}
              {site.dataKind === "imported"
                ? "IMPORTED RASTERS"
                : "SYNTHETIC DATA"}
            </span>
            <button
              className="icon-btn"
              onClick={() => setNotes(true)}
              aria-label="Method notes"
            >
              <CircleHelp size={18} />
            </button>
            <div className="avatar">AG</div>
          </div>
        </header>
        <div className="content">
          <div className="intro">
            <div>
              <div className="eyebrow">
                <i /> FOREST INTELLIGENCE / 01
              </div>
              <h1>
                Where did the forest <em>really</em> change?
              </h1>
              <p>
                Separate biomass movement from measurement uncertainty, then
                inspect the cells driving the result.
              </p>
            </div>
            <button
              className="outline-btn"
              disabled={!result}
              onClick={() => result && download(result)}
            >
              <Download size={16} /> Export analysis
            </button>
          </div>
          <div className="toolbar">
            <div className="control landscape-control">
              <label>LANDSCAPE</label>
              <div className="select-field">
                <MapPin size={16} />
                <select
                  value={siteId}
                  onChange={(e) => changeSite(e.target.value)}
                >
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <ChevronDown size={15} />
              </div>
            </div>
            <div className="divider" />
            <div className="control">
              <label>COMPARE YEARS</label>
              <div className="years">
                <select
                  value={start}
                  onChange={(e) => setStart(Math.min(+e.target.value, end - 1))}
                >
                  {[2018, 2019, 2020, 2021, 2022, 2023, 2024].map((y) => (
                    <option key={y}>{y}</option>
                  ))}
                </select>
                <ArrowRight size={15} />
                <select
                  value={end}
                  onChange={(e) => setEnd(Math.max(+e.target.value, start + 1))}
                >
                  {[2019, 2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
                    <option key={y}>{y}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="divider" />
            <div className="control">
              <label>CONFIDENCE LEVEL</label>
              <div className="segments">
                {[80, 90, 95].map((c) => (
                  <button
                    key={c}
                    className={confidence === c ? "chosen" : ""}
                    onClick={() => setConfidence(c)}
                  >
                    {c}%
                  </button>
                ))}
              </div>
            </div>
            <button className="reset" onClick={reset}>
              <RotateCcw size={15} /> Reset
            </button>
          </div>
          {error && (
            <div className="error">
              {error}
              <button onClick={() => setError("")}>
                <X size={15} />
              </button>
            </div>
          )}
          <section className="metrics">
            <div className="metric">
              <div className="metric-label">
                MEAN BIOMASS CHANGE <Activity size={16} />
              </div>
              <div className="metric-number">
                {result ? sign(result.summary.meanChange) : "—"}{" "}
                <small>t/ha</small>
              </div>
              <p>
                {result
                  ? result.start + " → " + result.end + " across selected area"
                  : "Loading analysis"}
              </p>
            </div>
            <div className="metric">
              <div className="metric-label">
                CHANGE INTERVAL <SlidersHorizontal size={16} />
              </div>
              <div className="metric-number interval">
                {result
                  ? sign(result.summary.siteInterval[0]) +
                    " to " +
                    sign(result.summary.siteInterval[1])
                  : "—"}
              </div>
              <p>{confidence}% interval · t/ha · illustrative model</p>
            </div>
            <div className="metric">
              <div className="metric-label">
                CLASSIFIED AREA <Layers3 size={16} />
              </div>
              <div className="metric-number">
                {result
                  ? Math.round((classified / result.summary.areaHa) * 100) + "%"
                  : "—"}
              </div>
              <p>
                {result
                  ? fmt(classified) +
                    " of " +
                    fmt(result.summary.areaHa) +
                    " ha"
                  : "Gain or loss above threshold"}
              </p>
            </div>
            <div className="metric verdict">
              <div className="metric-label">
                LANDSCAPE VERDICT <span>✳</span>
              </div>
              <div
                className={
                  "metric-number " + (result?.summary.siteDirection || "")
                }
              >
                {result
                  ? result.summary.siteDirection === "uncertain"
                    ? "Inconclusive"
                    : "Net " + result.summary.siteDirection
                  : "—"}
              </div>
              <p>Based on area-level change interval</p>
            </div>
          </section>
          <div className="work-grid">
            <section className="map-panel">
              <div className="panel-head">
                <div>
                  <div className="kicker">SPATIAL ANALYSIS</div>
                  <h2>Change signal map</h2>
                  <p>
                    {site.region} <span>·</span>{" "}
                    {fmt(result?.summary.sourcePixelCount || 0)} source pixels
                    at 30 m · {fmt(result?.summary.cellCount || 0)} display
                    blocks
                  </p>
                </div>
                <button
                  className="small-btn"
                  onClick={() => file.current?.click()}
                >
                  <Upload size={15} /> Upload boundary
                </button>
                <input
                  type="file"
                  hidden
                  ref={file}
                  accept=".json,.geojson"
                  onChange={(e) => {
                    upload(e.target.files?.[0]);
                    e.currentTarget.value = "";
                  }}
                />
              </div>
              <div className="map-frame">
                <MapContainer
                  center={site.center as LatLngExpression}
                  zoom={10}
                  zoomControl={false}
                  className="map"
                >
                  <FlyTo site={site} />
                  <ZoomControl position="bottomright" />
                  {base === "satellite" ? (
                    <TileLayer
                      attribution="Tiles © Esri, Maxar, Earthstar Geographics"
                      url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                    />
                  ) : (
                    <TileLayer
                      attribution="© OpenStreetMap © CARTO"
                      url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                    />
                  )}
                  {result?.cells.map((c) => (
                    <Rectangle
                      key={c.id}
                      bounds={c.bounds}
                      pathOptions={{
                        color: selected === c.id ? "#fff" : cellColor(c, layer),
                        weight: selected === c.id ? 2 : 0.35,
                        fillColor: cellColor(c, layer),
                        fillOpacity:
                          layer === "signal" && c.classification === "uncertain"
                            ? 0.46
                            : 0.77,
                        opacity: selected === c.id ? 1 : 0.4,
                      }}
                      eventHandlers={{ click: () => setSelected(c.id) }}
                    >
                      <Tooltip direction="top">
                        {sign(c.delta)} t/ha · {c.classification}
                      </Tooltip>
                    </Rectangle>
                  ))}
                  {boundary && (
                    <Polygon
                      positions={boundary}
                      pathOptions={{
                        color: "#ffffff",
                        weight: 2.5,
                        fillOpacity: 0,
                        dashArray: "5 5",
                      }}
                    />
                  )}
                </MapContainer>
                <div className="map-status">
                  <i /> {busy ? "PROCESSING" : "ANALYSIS READY"}
                </div>
                <button
                  className="base-switch"
                  onClick={() =>
                    setBase(base === "satellite" ? "street" : "satellite")
                  }
                >
                  <Satellite size={15} />
                  {base === "satellite" ? "Satellite" : "Streets"}
                  <ChevronDown size={13} />
                </button>
                <div className="coordinates">
                  {Math.abs(site.center[0]).toFixed(3)}°{" "}
                  {site.center[0] > 0 ? "N" : "S"} &nbsp;{" "}
                  {Math.abs(site.center[1]).toFixed(3)}°{" "}
                  {site.center[1] > 0 ? "E" : "W"}
                </div>
              </div>
              <div className="map-foot">
                <div className="tabs">
                  <button
                    className={layer === "signal" ? "on" : ""}
                    onClick={() => setLayer("signal")}
                  >
                    Significant change
                  </button>
                  <button
                    className={layer === "raw" ? "on" : ""}
                    onClick={() => setLayer("raw")}
                  >
                    Raw change
                  </button>
                  <button
                    className={layer === "uncertainty" ? "on" : ""}
                    onClick={() => setLayer("uncertainty")}
                  >
                    Uncertainty
                  </button>
                </div>
                <div className="legend">
                  {layer === "signal" ? (
                    <>
                      <span>
                        <i className="loss" /> Loss
                      </span>
                      <span>
                        <i className="uncertain" /> Uncertain
                      </span>
                      <span>
                        <i className="gain" /> Gain
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={"legend-gradient " + layer} />
                      <span>
                        {layer === "raw" ? "Loss → Gain" : "Lower → Higher SE"}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {polygonName && (
                <div className="boundary-chip">
                  <FileJson size={14} />
                  {polygonName}
                  <button
                    onClick={() => {
                      setPolygon(null);
                      setPolygonName("");
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </section>
            <div className="insights">
              <section className="insight-card">
                <div className="kicker">THE READOUT</div>
                <h2>{cell ? "Cell inspection" : "What the map is saying"}</h2>
                {cell ? (
                  <>
                    <p>
                      Selected cell at {cell.lat.toFixed(3)}°,{" "}
                      {cell.lon.toFixed(3)}°. Estimated change is{" "}
                      <b>{sign(cell.delta)} t/ha</b> with a change standard
                      error of {fmt(cell.changeSe, 1)} t/ha.
                    </p>
                    <div className="cell-row">
                      <span>CLASSIFICATION</span>
                      <strong className={cell.classification}>
                        {cell.classification}
                      </strong>
                    </div>
                    <div className="cell-row">
                      <span>START STOCK</span>
                      <strong>{fmt(cell.startStock, 1)} t/ha</strong>
                    </div>
                    <div className="cell-row">
                      <span>END STOCK</span>
                      <strong>{fmt(cell.endStock, 1)} t/ha</strong>
                    </div>
                    <div className="cell-row">
                      <span>STANDARDIZED CHANGE</span>
                      <strong>{sign(cell.score, 2)}σ</strong>
                    </div>
                    <button
                      className="text-btn"
                      onClick={() => setSelected(null)}
                    >
                      Clear selection <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <p>
                      {site.story} Colored cells show where the estimated change
                      clears the chosen confidence threshold.
                    </p>
                    <div className="class-list">
                      <div>
                        <i className="gain">
                          <ArrowUpRight size={20} />
                        </i>
                        <span>
                          <strong>
                            {result
                              ? fmt(result.summary.classAreaHa.gain)
                              : "—"}{" "}
                            ha
                          </strong>
                          <small>Significant biomass gain</small>
                        </span>
                      </div>
                      <div>
                        <i className="loss">
                          <ArrowDownRight size={20} />
                        </i>
                        <span>
                          <strong>
                            {result
                              ? fmt(result.summary.classAreaHa.loss)
                              : "—"}{" "}
                            ha
                          </strong>
                          <small>Significant biomass loss</small>
                        </span>
                      </div>
                      <div>
                        <i className="uncertain">≈</i>
                        <span>
                          <strong>
                            {result
                              ? fmt(result.summary.classAreaHa.uncertain)
                              : "—"}{" "}
                            ha
                          </strong>
                          <small>Direction remains uncertain</small>
                        </span>
                      </div>
                    </div>
                    <div className="tip">
                      <CircleHelp size={16} /> Click any cell to inspect its
                      estimate and uncertainty.
                    </div>
                  </>
                )}
              </section>
              <section className="method-card">
                <div className="method-symbol">✳</div>
                <div>
                  <strong>
                    Built to show the decision, not just the number.
                  </strong>
                  <p>
                    Adjacent cells and repeated measurements are correlated.
                    This sample model accounts for both.
                  </p>
                  <button onClick={() => setNotes(true)}>
                    View method notes <ArrowRight size={14} />
                  </button>
                </div>
              </section>
            </div>
          </div>
          <section className="audit-card">
            <div className="audit-head">
              <div>
                <div className="kicker">DECISION STABILITY</div>
                <h2>Does the conclusion survive different assumptions?</h2>
                <p>
                  Re-run the same raster difference across confidence thresholds
                  and paired-error correlations.
                </p>
              </div>
              <span className="audit-badge">9 SCENARIOS</span>
            </div>
            <div className="audit-grid">
              <div className="audit-table">
                <div className="audit-row audit-labels">
                  <span>TEMPORAL CORRELATION</span>
                  <span>80% CONFIDENCE</span>
                  <span>90% CONFIDENCE</span>
                  <span>95% CONFIDENCE</span>
                </div>
                {[0, 0.45, 0.8].map((rho) => (
                  <div className="audit-row" key={rho}>
                    <strong>
                      {rho === 0
                        ? "Independent years"
                        : rho === 0.45
                          ? "Base assumption"
                          : "Strongly paired"}{" "}
                      <small>ρ = {rho.toFixed(2)}</small>
                    </strong>
                    {[80, 90, 95].map((level) => {
                      const a = result?.decisionAudit.find(
                        (x) =>
                          x.temporalCorrelation === rho &&
                          x.confidence === level,
                      );
                      return (
                        <div
                          className={
                            "audit-outcome " + (a?.siteDirection || "")
                          }
                          key={level}
                        >
                          <b>
                            {a
                              ? a.siteDirection === "uncertain"
                                ? "Inconclusive"
                                : "Net " + a.siteDirection
                              : "—"}
                          </b>
                          <small>
                            {a
                              ? fmt(a.classifiedAreaHa) + " ha classified"
                              : "Loading"}
                          </small>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="audit-explain">
                <div className="audit-symbol">↗</div>
                <strong>
                  {result
                    ? auditAgree === 9
                      ? "Stable verdict"
                      : 9 -
                        auditAgree +
                        (9 - auditAgree === 1
                          ? " setting changes"
                          : " settings change") +
                        " the verdict"
                    : "Checking stability"}
                </strong>
                <p>
                  {result
                    ? auditAgree +
                      "/9 scenarios agree · " +
                      fmt(Math.min(...auditAreas)) +
                      "–" +
                      fmt(Math.max(...auditAreas)) +
                      " ha classified"
                    : "Comparing scenarios..."}
                </p>
                <button onClick={() => setNotes(true)}>
                  See assumptions <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </section>
          <div className="bottom-grid">
            <section className="chart-card">
              <div className="panel-head">
                <div>
                  <div className="kicker">TEMPORAL VIEW</div>
                  <h2>Biomass through time</h2>
                  <p>Area-weighted mean stock · 2018–2025 · t/ha</p>
                </div>
                <span className="chart-badge">
                  <i /> Sample time series
                </span>
              </div>
              <div className="chart">
                <TrendChart data={result?.series || []} />
              </div>
            </section>
            <section className="story-card">
              <div className="kicker">ENGINEERING PATH</div>
              <h2>From raster to decision.</h2>
              <div className="engineering-list">
                <div>
                  <span>01</span>
                  <strong>Aligned 30 m GeoTIFFs</strong>
                  <small>stock + standard error · 8 years</small>
                </div>
                <div>
                  <span>02</span>
                  <strong>Python analysis API</strong>
                  <small>AOI mask · covariance · validation</small>
                </div>
                <div>
                  <span>03</span>
                  <strong>Reviewable output</strong>
                  <small>map · audit · cell CSV</small>
                </div>
              </div>
              <a
                href="https://github.com/AndrewGordienko/forest-signal"
                target="_blank"
                rel="noreferrer"
              >
                View source and tests <ArrowRight size={15} />
              </a>
            </section>
          </div>
          <footer>
            FIELDNOTE / FOREST SIGNAL{" "}
            <span>
              Independent portfolio demonstration · Synthetic biomass data ·
              2026
            </span>
          </footer>
        </div>
      </main>
      {notes && (
        <div className="modal-backdrop" onClick={() => setNotes(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="modal-x" onClick={() => setNotes(false)}>
              <X size={20} />
            </button>
            <div className="eyebrow">
              <i /> METHOD NOTES
            </div>
            <h2>A transparent sample pipeline.</h2>
            <p>
              Every biomass value is deterministically generated for this
              independent portfolio demo. It does not use Chloris data,
              reproduce their models, or support real carbon claims.
            </p>
            <div className="method-list">
              <div>
                <b>01</b>
                <span>
                  <strong>Paired observations</strong>
                  <small>
                    Each cell has synthetic stock and standard error for each
                    year. Change is later minus earlier stock.
                  </small>
                </span>
              </div>
              <div>
                <b>02</b>
                <span>
                  <strong>Change uncertainty</strong>
                  <small>
                    The API propagates error from both years with assumed
                    temporal correlation of 0.45. The confidence control changes
                    the classification threshold.
                  </small>
                </span>
              </div>
              <div>
                <b>03</b>
                <span>
                  <strong>Area uncertainty</strong>
                  <small>
                    A 28% shared regional error component prevents adjacent
                    cells from falsely behaving as independent measurements.
                    Production use would require calibrated covariance and
                    validation.
                  </small>
                </span>
              </div>
              <div>
                <b>04</b>
                <span>
                  <strong>Geospatial delivery</strong>
                  <small>
                    {STATIC_MODE
                      ? "The public preview replays GeoTIFF-derived data in the browser. The repository contains the Python raster API."
                      : "The Python API clips GeoJSON areas, aggregates raster statistics, and returns inspectable cells."}
                  </small>
                </span>
              </div>
            </div>
            <button className="primary" onClick={() => setNotes(false)}>
              <Check size={17} /> Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
