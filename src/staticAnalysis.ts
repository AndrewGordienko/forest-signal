/* GitHub Pages replay of the raster pipeline. The checked-in JSON is exported
   from the same 30 m GeoTIFFs that the Python API reads. */
export const STATIC_MODE =
  (typeof window !== "undefined" &&
    window.location.hostname.endsWith("github.io")) ||
  import.meta.env?.VITE_STATIC_MODE === "true";
const rhoBase = 0.45;
const spatialShared = 0.28;
const zValues: Record<number, number> = {
  80: 1.2815515655,
  90: 1.6448536269,
  95: 1.9599639845,
};
const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
type Grid = {
  width: number;
  height: number;
  pixelAreaHa: number;
  lon: number[];
  lat: number[];
  se: (number | null)[];
  stock: Record<string, (number | null)[]>;
  blockBounds: Record<string, [[number, number], [number, number]]>;
};
const cached = new Map<string, Promise<Grid>>();
const dataUrl = (name: string) =>
  new URL(
    import.meta.env.BASE_URL + "demo-data/" + name,
    document.baseURI,
  ).toString();
export async function loadStaticSites() {
  const r = await fetch(dataUrl("sites.json"));
  if (!r.ok) throw Error("Could not load study areas");
  return (await r.json()).sites;
}
async function loadGrid(site: string) {
  if (!cached.has(site))
    cached.set(
      site,
      fetch(dataUrl(site + ".json")).then((r) => {
        if (!r.ok) throw Error("Could not load raster fixture");
        return r.json();
      }),
    );
  return cached.get(site)!;
}
function inRing(x: number, y: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
function inPolygon(x: number, y: number, geometry: object | null) {
  if (!geometry) return true;
  const g = geometry as { type: string; coordinates: number[][][] };
  if (g.type !== "Polygon" || !Array.isArray(g.coordinates))
    throw Error("Upload a GeoJSON Polygon.");
  if (!inRing(x, y, g.coordinates[0])) return false;
  return !g.coordinates.slice(1).some((r) => inRing(x, y, r));
}
function aggregateSE(a: number[], b: number[], rho: number) {
  const n = a.length,
    meanA = a.reduce((x, y) => x + y, 0) / n,
    meanB = b.reduce((x, y) => x + y, 0) / n;
  const va =
    spatialShared * meanA ** 2 +
    ((1 - spatialShared) * a.reduce((x, y) => x + y * y, 0)) / n ** 2;
  const vb =
    spatialShared * meanB ** 2 +
    ((1 - spatialShared) * b.reduce((x, y) => x + y * y, 0)) / n ** 2;
  return Math.sqrt(Math.max(0, va + vb - 2 * rho * Math.sqrt(va * vb)));
}
function classify(delta: number, se: number, level: number) {
  return delta > zValues[level] * se
    ? "gain"
    : delta < -zValues[level] * se
      ? "loss"
      : "uncertain";
}
const round = (x: number, n = 1) => Math.round(x * 10 ** n) / 10 ** n;
export async function analyzeStatic(input: {
  site: string;
  start: number;
  end: number;
  confidence: number;
  polygon: object | null;
}) {
  return analyzeGrid(await loadGrid(input.site), input);
}
export function analyzeGrid(
  grid: Grid,
  input: {
    site: string;
    start: number;
    end: number;
    confidence: number;
    polygon: object | null;
  },
) {
  const { site, start, end, confidence, polygon } = input;
  if (
    !years.includes(start) ||
    !years.includes(end) ||
    start >= end ||
    !zValues[confidence]
  )
    throw Error("Choose ordered years from 2018 through 2025.");
  const n = grid.width * grid.height;
  const selected: number[] = [];
  for (let i = 0; i < n; i++)
    if (
      grid.se[i] !== null &&
      grid.stock[String(start)][i] !== null &&
      grid.stock[String(end)][i] !== null &&
      inPolygon(grid.lon[i], grid.lat[i], polygon)
    )
      selected.push(i);
  if (!selected.length)
    throw Error(
      "The polygon does not contain any valid pixels in this study area.",
    );
  const startData = grid.stock[String(start)],
    endData = grid.stock[String(end)];
  const a = selected.map((i) => startData[i] as number),
    b = selected.map((i) => endData[i] as number),
    sa = selected.map((i) => grid.se[i] as number),
    sb = sa;
  const delta = b.map((v, i) => v - a[i]),
    meanChange = delta.reduce((x, y) => x + y, 0) / delta.length,
    siteSE = aggregateSE(sa, sb, rhoBase);
  const selectedSet = new Set(selected);
  const series = years.map((year) => {
    const data = grid.stock[String(year)];
    const values = selected
      .map((i) => data[i])
      .filter((v): v is number => v !== null);
    return {
      year,
      stock: values.length
        ? round(values.reduce((x, y) => x + y, 0) / values.length)
        : null,
    };
  });
  const cells = [] as Array<{
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
    classification: "gain" | "loss" | "uncertain";
    sourcePixels: number;
  }>;
  const blocks = [] as Array<{
    delta: number;
    sa: number[];
    sb: number[];
    area: number;
  }>;
  const classArea: { gain: number; loss: number; uncertain: number } = {
    gain: 0,
    loss: 0,
    uncertain: 0,
  };
  for (let row = 0; row < grid.height; row += 4)
    for (let col = 0; col < grid.width; col += 4) {
      const ids: number[] = [];
      for (let r = row; r < Math.min(row + 4, grid.height); r++)
        for (let c = col; c < Math.min(col + 4, grid.width); c++) {
          const i = r * grid.width + c;
          if (selectedSet.has(i)) ids.push(i);
        }
      if (!ids.length) continue;
      const aa = ids.map((i) => startData[i] as number),
        bb = ids.map((i) => endData[i] as number),
        saa = ids.map((i) => grid.se[i] as number),
        sbb = saa;
      const d = bb.reduce((sum, v, i) => sum + v - aa[i], 0) / ids.length,
        se = aggregateSE(saa, sbb, rhoBase),
        kind = classify(d, se, confidence),
        area = ids.length * grid.pixelAreaHa;
      classArea[kind] += area;
      blocks.push({ delta: d, sa: saa, sb: sbb, area });
      const id = Math.floor(row / 4) + "-" + Math.floor(col / 4),
        bounds = grid.blockBounds[id];
      cells.push({
        id,
        lat: round((bounds[0][0] + bounds[1][0]) / 2, 6),
        lon: round((bounds[0][1] + bounds[1][1]) / 2, 6),
        bounds,
        areaHa: round(area, 3),
        startStock: round(aa.reduce((x, y) => x + y, 0) / ids.length, 2),
        endStock: round(bb.reduce((x, y) => x + y, 0) / ids.length, 2),
        delta: round(d, 2),
        changeSe: round(se, 2),
        score: round(d / se, 2),
        classification: kind,
        sourcePixels: ids.length,
      });
    }
  const decisionAudit = [];
  for (const rho of [0, 0.45, 0.8])
    for (const level of [80, 90, 95]) {
      const scenarioSE = aggregateSE(sa, sb, rho);
      const area = blocks.reduce(
        (sum, block) =>
          sum +
          (classify(
            block.delta,
            aggregateSE(block.sa, block.sb, rho),
            level,
          ) === "uncertain"
            ? 0
            : block.area),
        0,
      );
      decisionAudit.push({
        temporalCorrelation: rho,
        confidence: level,
        siteDirection: classify(meanChange, scenarioSE, level),
        classifiedAreaHa: round(area),
        interval: [
          round(meanChange - zValues[level] * scenarioSE, 2),
          round(meanChange + zValues[level] * scenarioSE, 2),
        ],
      });
    }
  return {
    site,
    start,
    end,
    confidence,
    cells,
    series,
    decisionAudit,
    summary: {
      areaHa: round(selected.length * grid.pixelAreaHa),
      meanChange: round(meanChange, 2),
      siteInterval: [
        round(meanChange - zValues[confidence] * siteSE, 2),
        round(meanChange + zValues[confidence] * siteSE, 2),
      ],
      siteDirection: classify(meanChange, siteSE, confidence),
      classAreaHa: {
        gain: round(classArea.gain),
        loss: round(classArea.loss),
        uncertain: round(classArea.uncertain),
      },
      cellCount: cells.length,
      sourcePixelCount: selected.length,
    },
    provenance: {
      kind: "synthetic-geotiff-replay",
      resolutionMeters: 30,
      units: "t/ha",
      temporalCorrelation: rhoBase,
      spatialSharedVariance: spatialShared,
      methodVersion: "1.0.0",
    },
  };
}
