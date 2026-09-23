import { useState } from "react";

type Datum = { year: number; stock: number | null };
export default function TrendChart({ data }: { data: Datum[] }) {
  const [active, setActive] = useState<number | null>(null);
  const values = data.filter(
    (d): d is { year: number; stock: number } => d.stock !== null,
  );
  if (!values.length)
    return <div className="trend-empty">Waiting for raster time series…</div>;
  const min = Math.floor((Math.min(...values.map((d) => d.stock)) - 5) / 5) * 5;
  const max = Math.ceil((Math.max(...values.map((d) => d.stock)) + 5) / 5) * 5;
  const left = 46,
    right = 740,
    top = 15,
    bottom = 155;
  const x = (i: number) =>
    left + (i * (right - left)) / Math.max(1, values.length - 1);
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const points = values.map((d, i) => [x(i), y(d.stock)] as const);
  const line = points
    .map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1))
    .join(" ");
  const area =
    line + " L " + right + " " + bottom + " L " + left + " " + bottom + " Z";
  const tickValues = [min, (min + max) / 2, max];
  const selected = active === null ? null : values[active];
  return (
    <div className="trend-root">
      <svg
        viewBox="0 0 770 185"
        preserveAspectRatio="none"
        role="img"
        aria-label="Area-weighted biomass stock by year"
      >
        <defs>
          <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#7fac83" stopOpacity=".28" />
            <stop offset="100%" stopColor="#7fac83" stopOpacity="0" />
          </linearGradient>
        </defs>
        {tickValues.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={right}
              y1={y(t)}
              y2={y(t)}
              stroke="#e8ece7"
              strokeDasharray="3 4"
            />
            <text
              x={left - 11}
              y={y(t) + 4}
              textAnchor="end"
              fill="#909c93"
              fontSize="11"
            >
              {t.toFixed(0)}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#trend-fill)" />
        <path
          d={line}
          fill="none"
          stroke="#4f8460"
          strokeWidth="2.6"
          vectorEffect="non-scaling-stroke"
        />
        {values.map((d, i) => (
          <g
            key={d.year}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
          >
            <rect
              x={x(i) - 25}
              y={top}
              width="50"
              height={bottom - top}
              fill="transparent"
            />
            <circle
              cx={x(i)}
              cy={y(d.stock)}
              r={active === i ? 5 : 2.5}
              fill="#4f8460"
              stroke="#fff"
              strokeWidth="1.5"
            />
            <text
              x={x(i)}
              y="178"
              textAnchor="middle"
              fill="#909c93"
              fontSize="11"
            >
              {d.year}
            </text>
          </g>
        ))}
      </svg>
      {selected && (
        <div
          className="trend-tooltip"
          style={{
            left: (x(active!) / 770) * 100 + "%",
            top: (y(selected.stock) / 185) * 100 + "%",
          }}
        >
          <strong>{selected.year}</strong>
          <span>{selected.stock.toFixed(1)} t/ha</span>
        </div>
      )}
    </div>
  );
}
