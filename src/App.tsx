import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  Polygon,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
  ZoomControl,
} from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import {
  ArrowRight,
  Download,
  ExternalLink,
  Info,
  Satellite,
  Upload,
  X,
} from "lucide-react";
import TrendChart from "./TrendChart";
import { analyzeStatic, loadStaticSites, STATIC_MODE } from "./staticAnalysis";
import "leaflet/dist/leaflet.css";
import "./App.css";

type Kind = "gain" | "loss" | "uncertain";
type Site = {
  id: string;
  name: string;
  region: string;
  center: [number, number];
  bounds: [[number, number], [number, number]];
  color: string;
  story: string;
  dataKind?: string;
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
  classification: Kind;
};
type Scenario = {
  temporalCorrelation: number;
  confidence: number;
  siteDirection: Kind;
  classifiedAreaHa: number;
  interval: [number, number];
};
type Result = {
  site: string;
  start: number;
  end: number;
  confidence: number;
  cells: Cell[];
  series: { year: number; stock: number | null }[];
  decisionAudit: Scenario[];
  summary: {
    areaHa: number;
    meanChange: number;
    siteInterval: [number, number];
    siteDirection: Kind;
    classAreaHa: Record<Kind, number>;
    cellCount: number;
    sourcePixelCount: number;
  };
};
const examples: Site[] = [
  {
    id: "madre",
    name: "Madre de Dios",
    region: "Peru",
    center: [-12.82, -69.48],
    bounds: [
      [-12.98, -69.7],
      [-12.66, -69.26],
    ],
    color: "#d88773",
    story: "Loss, with one assumption-sensitive verdict",
  },
  {
    id: "algonquin",
    name: "Algonquin",
    region: "Canada",
    center: [45.65, -78.43],
    bounds: [
      [45.52, -78.65],
      [45.79, -78.2],
    ],
    color: "#c4a76d",
    story: "Local change, uncertain overall direction",
  },
  {
    id: "kalimantan",
    name: "Kalimantan",
    region: "Indonesia",
    center: [0.36, 115.36],
    bounds: [
      [0.2, 115.16],
      [0.52, 115.56],
    ],
    color: "#6aaf91",
    story: "Gain that survives every tested setting",
  },
];
const fmt = (n: number, digits = 0) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const sign = (n: number, digits = 1) => `${n > 0 ? "+" : ""}${fmt(n, digits)}`;
const verdict = (kind: Kind) =>
  kind === "uncertain" ? "Inconclusive" : `Net ${kind}`;
const pairing = (rho: number) =>
  rho === 0 ? "Independent" : rho === 0.45 ? "Baseline" : "Strongly paired";
function FlyTo({ site, cells }: { site: Site; cells?: Cell[] }) {
  const map = useMap();
  useEffect(() => {
    if (!cells?.length) {
      map.fitBounds(site.bounds, { padding: [25, 25], animate: false });
      return;
    }
    const south = Math.min(...cells.map((cell) => cell.bounds[0][0]));
    const west = Math.min(...cells.map((cell) => cell.bounds[0][1]));
    const north = Math.max(...cells.map((cell) => cell.bounds[1][0]));
    const east = Math.max(...cells.map((cell) => cell.bounds[1][1]));
    map.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      {
        padding: [30, 30],
        animate: true,
      },
    );
  }, [map, site, cells]);
  return null;
}
function cellColor(cell: Cell, layer: "raw" | "classified") {
  if (layer === "classified")
    return cell.classification === "gain"
      ? "#68b694"
      : cell.classification === "loss"
        ? "#e27661"
        : "#dec894";
  return cell.delta < -32
    ? "#c95951"
    : cell.delta < -12
      ? "#df8e73"
      : cell.delta < 4
        ? "#e3d6ae"
        : cell.delta < 18
          ? "#a8c897"
          : "#5daa90";
}
function exportCsv(result: Result) {
  const rows = [
    "cell_id,lat,lon,area_ha,start_t_ha,end_t_ha,change_t_ha,change_se_t_ha,z_score,class",
    ...result.cells.map((cell) =>
      [
        cell.id,
        cell.lat,
        cell.lon,
        cell.areaHa,
        cell.startStock,
        cell.endStock,
        cell.delta,
        cell.changeSe,
        cell.score,
        cell.classification,
      ].join(","),
    ),
  ];
  const url = URL.createObjectURL(
    new Blob([rows.join("\n")], { type: "text/csv" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `forest-signal-${result.site}-${result.start}-${result.end}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const [sites, setSites] = useState(examples);
  const [siteId, setSiteId] = useState("madre");
  const [start, setStart] = useState(2018);
  const [end, setEnd] = useState(2025);
  const [confidence, setConfidence] = useState(95);
  const [layer, setLayer] = useState<"raw" | "classified">("classified");
  const [base, setBase] = useState<"satellite" | "street">("satellite");
  const [result, setResult] = useState<Result | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<[number, number]>([0, 95]);
  const [polygon, setPolygon] = useState<object | null>(null);
  const [polygonName, setPolygonName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notes, setNotes] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const site = sites.find((item) => item.id === siteId) ?? examples[0];
  const visible =
    result?.site === siteId &&
    result.start === start &&
    result.end === end &&
    result.confidence === confidence
      ? result
      : null;
  const cell = visible?.cells.find((item) => item.id === selectedId);
  const rawLossArea =
    visible?.cells.reduce(
      (sum, item) => sum + (item.delta < 0 ? item.areaHa : 0),
      0,
    ) ?? 0;
  const rawGainArea =
    visible?.cells.reduce(
      (sum, item) => sum + (item.delta >= 0 ? item.areaHa : 0),
      0,
    ) ?? 0;
  const areaRows: { kind: Kind; label: string; area: number }[] =
    layer === "raw"
      ? [
          { kind: "loss", label: "Estimated decrease", area: rawLossArea },
          { kind: "gain", label: "Estimated increase", area: rawGainArea },
        ]
      : (["loss", "uncertain", "gain"] as Kind[]).map((kind) => ({
          kind,
          label: kind === "uncertain" ? "Unresolved" : kind,
          area: visible?.summary.classAreaHa[kind] ?? 0,
        }));
  const scenario = visible?.decisionAudit.find(
    (item) =>
      item.temporalCorrelation === focus[0] && item.confidence === focus[1],
  );
  const baseline = visible?.decisionAudit.find(
    (item) =>
      item.temporalCorrelation === 0.45 && item.confidence === confidence,
  );
  const agree =
    visible?.decisionAudit.filter(
      (item) => item.siteDirection === visible.summary.siteDirection,
    ).length ?? 0;
  const boundary = polygon
    ? (polygon as { coordinates: number[][][] }).coordinates?.[0]?.map(
        (point) => [point[1], point[0]] as [number, number],
      )
    : null;
  useEffect(() => {
    (STATIC_MODE
      ? loadStaticSites()
      : fetch("/api/sites")
          .then((response) => response.json())
          .then((data) => data.sites)
    )
      .then((data) => {
        if (Array.isArray(data)) {
          const known = examples.map((item) => ({
            ...data.find((remote: Site) => remote.id === item.id),
            ...item,
          }));
          const imported = data.filter(
            (remote: Site) => !examples.some((item) => item.id === remote.id),
          );
          setSites([...known, ...imported]);
        }
      })
      .catch((cause) => setError(cause.message));
  }, []);
  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      setBusy(true);
      setError("");
      (STATIC_MODE
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
          }).then(async (response) => {
            const data = await response.json();
            if (!response.ok) throw Error(data.detail || "Analysis failed");
            return data as Result;
          })
      )
        .then((data) => {
          if (id === requestId.current) {
            setResult(data as Result);
            setSelectedId(null);
          }
        })
        .catch((cause) => {
          if (id === requestId.current) setError(cause.message);
        })
        .finally(() => {
          if (id === requestId.current) setBusy(false);
        });
    }, 80);
    return () => clearTimeout(timer);
  }, [siteId, start, end, confidence, polygon]);
  function chooseSite(id: string) {
    setSiteId(id);
    setPolygon(null);
    setPolygonName("");
    setSelectedId(null);
    setFocus([0, 95]);
  }
  async function upload(file?: File) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const geometry =
        json.type === "FeatureCollection"
          ? json.features?.[0]?.geometry
          : json.type === "Feature"
            ? json.geometry
            : json;
      if (geometry?.type !== "Polygon")
        throw Error("Choose a GeoJSON Polygon.");
      setPolygon(geometry);
      setPolygonName(file.name);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not read GeoJSON",
      );
    }
  }
  const mean = visible?.summary.meanChange ?? 0;
  const interval = visible?.summary.siteInterval ?? [-1, 1];
  const scaleMin = Math.min(interval[0], 0) - 5;
  const scaleMax = Math.max(interval[1], 0) + 5;
  const onScale = (value: number) =>
    `${((value - scaleMin) / (scaleMax - scaleMin)) * 100}%`;

  return (
    <div className="page">
      <header className="site-header">
        <a className="wordmark" href="#top">
          <span className="mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          <span>
            forest<span className="wordmark-light">signal</span>
          </span>
        </a>
        <nav aria-label="Page sections">
          <a href="#observation">01 / Observation</a>
          <a href="#map">02 / The map</a>
          <a href="#sensitivity">03 / Sensitivity</a>
        </nav>
        <a
          className="source-link"
          href="https://github.com/AndrewGordienko/forest-signal"
          target="_blank"
          rel="noreferrer"
        >
          Source <ExternalLink size={14} />
        </a>
      </header>
      <main id="top">
        <section className="hero article-width">
          <div className="hero-meta">
            <span className="live-dot" /> INTERACTIVE CASE STUDY{" "}
            <span className="meta-separator">/</span> FOREST BIOMASS
          </div>
          <h1>
            Did this forest <em>actually</em> change?
          </h1>
          <p className="hero-deck">
            A measured difference is easy to map. Deciding whether it is
            meaningful takes one more step. Explore three synthetic landscapes
            and see where uncertainty changes the call.
          </p>
          <div className="byline">
            <span className="author-avatar">AG</span>
            <span>
              Andrew Gordienko{" "}
              <small>Geospatial engineering portfolio · September 2026</small>
            </span>
            <span className="byline-rule" />
            <span className="synthetic-label">SYNTHETIC GEOTIFF DATA</span>
          </div>
        </section>
        <section className="lab-shell" aria-label="Interactive analysis">
          <div className="lab-header">
            <div>
              <span className="section-number">THE LIVE ANALYSIS</span>
              <h2>Choose a landscape.</h2>
            </div>
            <span className="lab-status">
              <span className="live-dot" />{" "}
              {busy ? "RECALCULATING" : "READY TO EXPLORE"}
            </span>
          </div>
          <div className="site-picker">
            {sites.map((item, index) => (
              <button
                className={`site-card ${siteId === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => chooseSite(item.id)}
                aria-pressed={siteId === item.id}
              >
                <span className="site-card-top">
                  <span className="site-index">0{index + 1}</span>
                  <span
                    className="site-dot"
                    style={{ background: item.color }}
                  />
                </span>
                <strong>{item.name}</strong>
                <small>{item.region}</small>
                <span className="site-story">{item.story}</span>
                <span className="site-card-arrow">
                  <ArrowRight size={16} />
                </span>
              </button>
            ))}
          </div>
          <div className="controls">
            <div className="control-title">COMPARE OBSERVATIONS</div>
            <label>
              From{" "}
              <select
                value={start}
                onChange={(event) =>
                  setStart(Math.min(+event.target.value, end - 1))
                }
              >
                {[2018, 2019, 2020, 2021, 2022, 2023, 2024].map((year) => (
                  <option key={year}>{year}</option>
                ))}
              </select>
            </label>
            <ArrowRight size={16} className="control-arrow" />
            <label>
              To{" "}
              <select
                value={end}
                onChange={(event) =>
                  setEnd(Math.max(+event.target.value, start + 1))
                }
              >
                {[2019, 2020, 2021, 2022, 2023, 2024, 2025].map((year) => (
                  <option key={year}>{year}</option>
                ))}
              </select>
            </label>
            <div className="control-spacer" />
            <label className="confidence-label">
              Confidence{" "}
              <select
                value={confidence}
                onChange={(event) => setConfidence(+event.target.value)}
              >
                {[80, 90, 95].map((level) => (
                  <option key={level} value={level}>
                    {level}%
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}
        </section>
        <section className="chapter article-width" id="observation">
          <div className="chapter-heading">
            <span className="chapter-index">01</span>
            <div>
              <span className="section-number">THE OBSERVATION</span>
              <h2>
                The average moved. How much of that movement can we trust?
              </h2>
            </div>
          </div>
          <p className="chapter-intro">
            Across {site.name}, the mean biomass estimate changed by{" "}
            <strong>
              {visible ? `${sign(mean)} tonnes per hectare` : "—"}
            </strong>{" "}
            between {start} and {end}. The interval includes uncertainty from
            both observations and shared regional error.
          </p>
          <div className="observation-grid">
            <div className="figure-panel interval-panel">
              <div className="figure-top">
                <span>FIGURE 1 / ESTIMATED CHANGE</span>
                <span>t/ha</span>
              </div>
              <div className="change-number">
                <span className={mean < 0 ? "negative" : "positive"}>
                  {visible ? sign(mean) : "—"}
                </span>
                <small>t/ha</small>
              </div>
              <div
                className="interval-chart"
                aria-label={
                  visible
                    ? `${confidence}% interval from ${interval[0]} to ${interval[1]} tonnes per hectare`
                    : "Loading interval"
                }
              >
                <div className="interval-track">
                  <span className="zero-line" style={{ left: onScale(0) }} />
                  <span
                    className="interval-range"
                    style={{
                      left: onScale(interval[0]),
                      width: `${((interval[1] - interval[0]) / (scaleMax - scaleMin)) * 100}%`,
                    }}
                  />
                  <span
                    className="interval-point"
                    style={{ left: onScale(mean) }}
                  />
                </div>
                <div className="interval-labels">
                  <span style={{ left: onScale(interval[0]) }}>
                    {visible ? sign(interval[0]) : "—"}
                  </span>
                  <span className="zero-label" style={{ left: onScale(0) }}>
                    0 / NO CHANGE
                  </span>
                  <span style={{ left: onScale(interval[1]) }}>
                    {visible ? sign(interval[1]) : "—"}
                  </span>
                </div>
              </div>
              <p className="figure-caption">
                {confidence}% change interval · The vertical line marks zero
                change.
              </p>
            </div>
            <div
              className={`finding-card ${visible?.summary.siteDirection ?? "uncertain"}`}
            >
              <span className="finding-label">CURRENT CONCLUSION</span>
              <strong>
                {visible
                  ? verdict(visible.summary.siteDirection)
                  : "Calculating…"}
              </strong>
              <p>
                {visible
                  ? visible.summary.siteDirection === "uncertain"
                    ? "The area-wide interval crosses zero. Local changes exist, but the whole landscape has no clear direction under this setting."
                    : `The ${confidence}% area-wide interval stays ${mean < 0 ? "below" : "above"} zero. This supports a net ${mean < 0 ? "loss" : "gain"} under the baseline error assumption.`
                  : "Reading the raster stack…"}
              </p>
              <span className="finding-foot">
                {visible
                  ? `${fmt(visible.summary.areaHa)} ha assessed · ${fmt(visible.summary.sourcePixelCount)} source pixels`
                  : ""}
              </span>
            </div>
          </div>
          <div className="trend-figure">
            <div className="figure-top">
              <span>CONTEXT / BIOMASS STOCK BY YEAR</span>
              <span>AREA-WEIGHTED MEAN · t/ha</span>
            </div>
            <div className="trend-chart">
              <TrendChart data={visible?.series ?? []} />
            </div>
          </div>
        </section>
        <section className="chapter map-chapter" id="map">
          <div className="article-width">
            <div className="chapter-heading">
              <span className="chapter-index">02</span>
              <div>
                <span className="section-number">THE SPATIAL EVIDENCE</span>
                <h2>
                  The same difference looks different once uncertainty is
                  applied.
                </h2>
              </div>
            </div>
            <p className="chapter-intro">
              Switch between the raw biomass difference and the
              confidence-filtered map. Select a block to inspect the numbers
              behind its color.
            </p>
          </div>
          <div className="map-workbench">
            <div className="map-toolbar">
              <div className="layer-switch" role="group" aria-label="Map layer">
                <button
                  className={layer === "raw" ? "active" : ""}
                  onClick={() => setLayer("raw")}
                >
                  Raw difference
                </button>
                <button
                  className={layer === "classified" ? "active" : ""}
                  onClick={() => setLayer("classified")}
                >
                  After uncertainty
                </button>
              </div>
              <div className="map-actions">
                <button onClick={() => fileInput.current?.click()}>
                  <Upload size={15} /> Upload AOI
                </button>
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  accept=".json,.geojson"
                  onChange={(event) => {
                    upload(event.target.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
                <button
                  disabled={!visible}
                  onClick={() => visible && exportCsv(visible)}
                >
                  <Download size={15} /> Cell CSV
                </button>
              </div>
            </div>
            <div className="map-body">
              <div className="map-frame">
                <MapContainer
                  center={site.center as LatLngExpression}
                  zoom={10}
                  zoomControl={false}
                  className="map"
                >
                  <FlyTo site={site} cells={visible?.cells} />
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
                  {visible?.cells.map((item) => (
                    <Rectangle
                      key={item.id}
                      bounds={item.bounds}
                      pathOptions={{
                        color:
                          selectedId === item.id
                            ? "#fff"
                            : cellColor(item, layer),
                        weight: selectedId === item.id ? 2.5 : 0.4,
                        fillColor: cellColor(item, layer),
                        fillOpacity:
                          layer === "classified" &&
                          item.classification === "uncertain"
                            ? 0.46
                            : 0.79,
                        opacity: selectedId === item.id ? 1 : 0.5,
                      }}
                      eventHandlers={{ click: () => setSelectedId(item.id) }}
                    >
                      <Tooltip direction="top">
                        {sign(item.delta)} t/ha · {item.classification}
                      </Tooltip>
                    </Rectangle>
                  ))}
                  {boundary && (
                    <Polygon
                      positions={boundary}
                      pathOptions={{
                        color: "#fff",
                        weight: 2.5,
                        fillOpacity: 0,
                        dashArray: "5 5",
                      }}
                    />
                  )}
                </MapContainer>
                <div className="map-overlay">
                  <span className="live-dot" />{" "}
                  {busy ? "RECALCULATING" : "30 M SOURCE RASTERS"}
                </div>
                <button
                  className="base-switch"
                  onClick={() =>
                    setBase(base === "satellite" ? "street" : "satellite")
                  }
                >
                  <Satellite size={15} />{" "}
                  {base === "satellite" ? "Satellite" : "Streets"}
                </button>
              </div>
              <aside className="map-inspector">
                <span className="section-number">
                  {cell ? "SELECTED BLOCK" : "MAP READOUT"}
                </span>
                {cell ? (
                  <>
                    <h3>
                      {sign(cell.delta)} <small>t/ha</small>
                    </h3>
                    <span
                      className={`classification-pill ${cell.classification}`}
                    >
                      {cell.classification === "uncertain"
                        ? "Inconclusive"
                        : cell.classification}
                    </span>
                    <p>
                      This display block changed from {fmt(cell.startStock, 1)}{" "}
                      to {fmt(cell.endStock, 1)} t/ha. Its change standard error
                      is {fmt(cell.changeSe, 1)} t/ha.
                    </p>
                    <dl>
                      <div>
                        <dt>AREA</dt>
                        <dd>{fmt(cell.areaHa, 1)} ha</dd>
                      </div>
                      <div>
                        <dt>STANDARDIZED CHANGE</dt>
                        <dd>{sign(cell.score, 2)}σ</dd>
                      </div>
                      <div>
                        <dt>COORDINATES</dt>
                        <dd>
                          {cell.lat.toFixed(3)}°, {cell.lon.toFixed(3)}°
                        </dd>
                      </div>
                    </dl>
                    <button
                      className="text-action"
                      onClick={() => setSelectedId(null)}
                    >
                      Clear selection <X size={14} />
                    </button>
                  </>
                ) : (
                  <>
                    <h3>
                      {layer === "raw"
                        ? "Measured difference"
                        : "Supported change"}
                    </h3>
                    <p>
                      {layer === "raw"
                        ? "Every block is colored by estimated direction and size. This view alone does not show which changes clear the uncertainty threshold."
                        : "Only blocks whose change clears the chosen confidence threshold receive a gain or loss classification."}
                    </p>
                    <div className="area-bars">
                      {areaRows.map((row) => (
                        <div key={row.kind}>
                          <span>{row.label}</span>
                          <strong>{visible ? fmt(row.area) : "—"} ha</strong>
                          <div>
                            <i
                              className={row.kind}
                              style={{
                                width: visible
                                  ? `${(row.area / visible.summary.areaHa) * 100}%`
                                  : "0%",
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    <span className="inspector-hint">
                      Click a map block to inspect its estimate.
                    </span>
                  </>
                )}
              </aside>
            </div>
            <div className="map-footer">
              <div className="map-legend">
                {layer === "classified" ? (
                  <>
                    <span>
                      <i className="loss" /> Loss
                    </span>
                    <span>
                      <i className="uncertain" /> Unresolved
                    </span>
                    <span>
                      <i className="gain" /> Gain
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      <i className="loss" /> Larger loss
                    </span>
                    <span>
                      <i className="uncertain" /> Near zero
                    </span>
                    <span>
                      <i className="gain" /> Larger gain
                    </span>
                  </>
                )}
              </div>
              <span>
                {fmt(visible?.summary.cellCount ?? 0)} display blocks ·{" "}
                {fmt(visible?.summary.sourcePixelCount ?? 0)} source pixels
              </span>
            </div>
            {polygonName && (
              <div className="boundary-chip">
                Clipped to {polygonName}
                <button
                  onClick={() => {
                    setPolygon(null);
                    setPolygonName("");
                  }}
                  aria-label="Remove boundary"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        </section>
        <section
          className="chapter article-width sensitivity-chapter"
          id="sensitivity"
        >
          <div className="chapter-heading">
            <span className="chapter-index">03</span>
            <div>
              <span className="section-number">THE DECISION CHECK</span>
              <h2>Would you make the same call with different assumptions?</h2>
            </div>
          </div>
          <p className="chapter-intro">
            Each square re-runs the same raster difference. Columns change the
            confidence threshold; rows change how strongly errors in the two
            years are paired. Select a square to inspect its result.
          </p>
          <div className="audit-layout">
            <div className="scenario-matrix">
              <div className="matrix-head">
                <span>TEMPORAL PAIRING</span>
                {[80, 90, 95].map((level) => (
                  <span key={level}>{level}% confidence</span>
                ))}
              </div>
              {[0, 0.45, 0.8].map((rho) => (
                <div className="matrix-row" key={rho}>
                  <div className="row-label">
                    <strong>{pairing(rho)}</strong>
                    <small>ρ = {rho.toFixed(2)}</small>
                  </div>
                  {[80, 90, 95].map((level) => {
                    const item = visible?.decisionAudit.find(
                      (entry) =>
                        entry.temporalCorrelation === rho &&
                        entry.confidence === level,
                    );
                    const focused = focus[0] === rho && focus[1] === level;
                    return (
                      <button
                        key={level}
                        className={`scenario ${item?.siteDirection ?? "uncertain"} ${focused ? "focused" : ""}`}
                        onClick={() => setFocus([rho, level])}
                        aria-pressed={focused}
                      >
                        <span>{item ? verdict(item.siteDirection) : "—"}</span>
                        <small>
                          {item
                            ? `${fmt(item.classifiedAreaHa)} ha classified`
                            : "Loading"}
                        </small>
                        {rho === 0.45 && level === confidence && (
                          <i title="Current map setting" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="scenario-detail">
              <span className="section-number">SELECTED SCENARIO</span>
              <h3>
                {scenario ? verdict(scenario.siteDirection) : "Calculating…"}
              </h3>
              <p>
                {pairing(focus[0])} years · {focus[1]}% confidence
              </p>
              <dl>
                <div>
                  <dt>CHANGE INTERVAL</dt>
                  <dd>
                    {scenario
                      ? `${sign(scenario.interval[0])} to ${sign(scenario.interval[1])} t/ha`
                      : "—"}
                  </dd>
                </div>
                <div>
                  <dt>CLASSIFIED AREA</dt>
                  <dd>
                    {scenario ? `${fmt(scenario.classifiedAreaHa)} ha` : "—"}
                  </dd>
                </div>
              </dl>
              {scenario && baseline && (
                <div className="scenario-note">
                  {scenario.siteDirection === baseline.siteDirection
                    ? "The direction agrees with the current map setting."
                    : "The conclusion changes under this assumption. That is the decision risk this check exposes."}
                </div>
              )}
            </div>
          </div>
          <p className="audit-takeaway">
            {visible
              ? agree === 9
                ? "All nine settings support the same area-wide conclusion."
                : `${9 - agree} of 9 settings change the area-wide conclusion. The classified map area also shifts with the uncertainty assumptions.`
              : "Comparing nine settings…"}
          </p>
        </section>
        <section className="closing article-width">
          <div>
            <span className="section-number">WHAT WAS BUILT</span>
            <h2>From raster files to a reviewable decision.</h2>
            <p>
              The pipeline validates annual 30 m GeoTIFFs, clips a GeoJSON area,
              propagates paired uncertainty, and returns both map blocks and
              area-wide conclusions. This case study uses deterministic
              synthetic data so the workflow can be inspected and reproduced.
            </p>
            <div className="closing-actions">
              <button onClick={() => setNotes(true)}>
                <Info size={16} /> Method & limitations
              </button>
              <a
                href="https://github.com/AndrewGordienko/forest-signal"
                target="_blank"
                rel="noreferrer"
              >
                Inspect the code <ArrowRight size={16} />
              </a>
            </div>
          </div>
          <div className="pipeline">
            <div>
              <span>01</span>
              <strong>Validate</strong>
              <small>stock + standard error rasters</small>
            </div>
            <div>
              <span>02</span>
              <strong>Compute</strong>
              <small>AOI mask + paired covariance</small>
            </div>
            <div>
              <span>03</span>
              <strong>Review</strong>
              <small>map + sensitivity + CSV</small>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>FOREST SIGNAL / ANDREW GORDIENKO</span>
        <span>
          Independent portfolio project · Synthetic data · No carbon accounting
          claims
        </span>
        <a href="#top">Back to top ↑</a>
      </footer>
      {notes && (
        <div className="modal-backdrop" onClick={() => setNotes(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Method and limitations"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setNotes(false)}
              aria-label="Close"
            >
              <X size={20} />
            </button>
            <span className="section-number">METHOD & LIMITATIONS</span>
            <h2>What the analysis computes</h2>
            <p>
              All displayed biomass values are generated fixtures. The demo does
              not use Chloris data or reproduce Chloris models.
            </p>
            <div className="method-list">
              <div>
                <b>01</b>
                <span>
                  <strong>Paired change</strong>
                  <small>
                    For each source pixel, change is later stock minus earlier
                    stock. Change variance is SE₁² + SE₂² − 2ρSE₁SE₂.
                  </small>
                </span>
              </div>
              <div>
                <b>02</b>
                <span>
                  <strong>Spatial aggregation</strong>
                  <small>
                    A 28% shared regional variance component prevents
                    neighboring pixels from appearing fully independent. The
                    baseline temporal correlation is ρ = 0.45.
                  </small>
                </span>
              </div>
              <div>
                <b>03</b>
                <span>
                  <strong>Classification</strong>
                  <small>
                    A gain or loss clears the selected normal confidence
                    threshold. The nine scenario check varies confidence and
                    temporal correlation.
                  </small>
                </span>
              </div>
              <div>
                <b>04</b>
                <span>
                  <strong>Production boundary</strong>
                  <small>
                    Real use requires calibrated covariance, independent
                    reference plots or LiDAR, coverage tests across ecosystems,
                    and review of spatial autocorrelation.
                  </small>
                </span>
              </div>
            </div>
            <button className="modal-done" onClick={() => setNotes(false)}>
              Close notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
