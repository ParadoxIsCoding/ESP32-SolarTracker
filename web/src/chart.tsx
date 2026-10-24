import { useEffect, useRef } from "preact/hooks";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { TZ, fmtDateTime, fmtDay, fmtTime } from "./time";

export type Style = "line" | "area" | "bars" | "step";
export interface SeriesDef {
  label: string;
  color: string;
  axis: string; // scale key
  style?: Style;
  dash?: boolean;
  width?: number;
  smooth?: boolean; // monotone spline (no overshoot), presentation only
  barSize?: number; // bar width as a fraction of the slot (default 0.7)
  show?: boolean;
  fmt: (v: number | null) => string;
}
export interface AxisDef {
  key: string;
  label: string;
  side: "left" | "right";
  fmt: (v: number) => string;
  min?: number;
  max?: number;
}
export interface ChartProps {
  x: number[];
  ys: (number | null)[][];
  series: SeriesDef[];
  axes: AxisDef[];
  height: number;
  xKind?: "time" | "day";
  gapSec?: number; // break lines when samples are further apart than this
  onZoom?: (min: number, max: number) => void;
  onReady?: (u: uPlot | null) => void;
  xRange?: [number, number];
}

/**
 * Inserts nulls where consecutive samples are further apart than `gap`, and
 * bridges per-series holes that only exist because several series share one
 * x axis (e.g. today's curve has no value at a timestamp only yesterday has).
 * uPlot breaks lines at `null` but spans `undefined`.
 */
export function withGaps(x: number[], ys: (number | null)[][], gap: number) {
  if (!gap || x.length < 2) return { x, ys };
  const nx: number[] = [];
  const nys: (number | null | undefined)[][] = ys.map(() => []);
  for (let i = 0; i < x.length; i++) {
    if (i && x[i] - x[i - 1] > gap) {
      nx.push(x[i - 1] + 1);
      nys.forEach((a) => a.push(null));
    }
    nx.push(x[i]);
    ys.forEach((a, k) => nys[k].push(a[i]));
  }
  for (const a of nys) {
    let prev = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] == null) continue;
      if (prev >= 0 && i - prev > 1 && nx[i] - nx[prev] <= gap) for (let j = prev + 1; j < i; j++) a[j] = undefined;
      prev = i;
    }
  }
  return { x: nx, ys: nys };
}

const grid = { stroke: "#1f2a3a", width: 1, dash: [4, 6] };
const ticks = { show: false };
const font = '12px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';

function hexA(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function tooltipPlugin(series: SeriesDef[], xKind: "time" | "day") {
  let tip: HTMLDivElement;
  return {
    hooks: {
      init: (u: uPlot) => {
        tip = document.createElement("div");
        tip.className = "tip";
        tip.style.display = "none";
        u.over.appendChild(tip);
        u.over.addEventListener("mouseleave", () => (tip.style.display = "none"));
      },
      setCursor: (u: uPlot) => {
        const i = u.cursor.idx;
        if (i == null || u.cursor.left == null || u.cursor.left < 0) {
          tip.style.display = "none";
          return;
        }
        const x = u.data[0][i];
        let rows = "";
        series.forEach((s, k) => {
          if (!u.series[k + 1].show) return;
          const v = (u.data[k + 1][i] ?? null) as number | null;
          rows += `<div class="r"><span><i style="background:${s.color}"></i>${s.label}</span><b class="num">${s.fmt(v)}</b></div>`;
        });
        tip.innerHTML = `<div class="t">${xKind === "day" ? fmtDay(x + 43200) : fmtDateTime(x)}</div>${rows}`;
        tip.style.display = "block";
        const w = u.over.clientWidth, tw = tip.offsetWidth;
        const left = u.cursor.left + 14 + tw > w ? u.cursor.left - tw - 14 : u.cursor.left + 14;
        tip.style.left = `${Math.max(0, left)}px`;
        tip.style.top = `${Math.max(0, (u.cursor.top ?? 0) - 10)}px`;
      },
    },
  };
}

function seriesOpts(s: SeriesDef, height: number): uPlot.Series {
  const style = s.style ?? "line";
  const o: uPlot.Series = {
    label: s.label,
    scale: s.axis,
    stroke: s.color,
    width: s.width ?? 2,
    show: s.show !== false,
    spanGaps: false,
    points: { show: false },
    dash: s.dash ? [6, 5] : undefined,
  };
  if (style === "area") {
    o.fill = (u: uPlot) => {
      const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height || height);
      g.addColorStop(0, hexA(s.color, 0.32));
      g.addColorStop(1, hexA(s.color, 0.02));
      return g;
    };
  }
  if (style === "bars") {
    o.paths = uPlot.paths.bars!({ size: [s.barSize ?? 0.7, 60], gap: 2 });
    o.fill = hexA(s.color, 0.85);
    o.width = 0;
  } else if (style === "step") {
    o.paths = uPlot.paths.stepped!({ align: 1 });
  } else if (s.smooth) {
    o.paths = uPlot.paths.spline!();
  }
  return o;
}

export function Chart(p: ChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const structure = JSON.stringify([p.series.map(({ fmt, ...r }) => r), p.axes.map(({ fmt, ...r }) => r), p.height, p.xKind]);
  const data = (): uPlot.AlignedData => {
    const g = withGaps(p.x, p.ys, p.gapSec ?? 0);
    return [g.x, ...g.ys] as uPlot.AlignedData;
  };

  useEffect(() => {
    if (!el.current) return;
    const xKind = p.xKind ?? "time";
    const scales: uPlot.Scales = { x: { time: true } };
    if (p.xRange) scales.x.range = () => p.xRange!;
    else if (xKind === "day")
      // daily bars: pad half a day each side so one or two days don't stretch the axis
      scales.x.range = (_u, min, max) => [min - 43200, Math.max(max, min + 6 * 86400) + 43200];
    for (const a of p.axes)
      scales[a.key] = {
        range: (_u, min, max) => {
          let lo = a.min ?? Math.min(0, min), hi = a.max ?? max;
          if (min == null || !isFinite(min)) return [a.min ?? 0, a.max ?? 1];
          if (a.min == null && min > 0 && min > (max - min) * 1.5) lo = min - (max - min) * 0.1;
          if (hi <= lo) hi = lo + 1;
          return [lo, hi + (hi - lo) * 0.06];
        },
      };
    const axes: uPlot.Axis[] = [
      {
        stroke: "#94a3b8", grid: { show: false }, ticks, font, gap: 8, size: 34,
        values: (_u, vals) => vals.map((v) => (xKind === "day" ? fmtDay(v + 43200).replace(/^\w+,? /, "") : fmtTime(v))),
      },
      ...p.axes.map((a, i): uPlot.Axis => ({
        scale: a.key, side: a.side === "left" ? 3 : 1, stroke: "#94a3b8", font, ticks,
        grid: i === 0 ? grid : { show: false }, gap: 6, size: 54,
        values: (_u, vals) => vals.map(a.fmt),
        label: p.axes.length > 1 ? a.label : undefined, labelFont: font, labelSize: 18,
      })),
    ];
    const opts: uPlot.Options = {
      width: el.current.clientWidth || 600,
      height: p.height,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), TZ),
      scales,
      axes,
      legend: { show: false },
      cursor: {
        drag: { x: !!p.onZoom, y: false, setScale: false },
        points: { size: 7, fill: (u, i) => u.series[i].stroke as string },
        sync: { key: "solar" },
        focus: { prox: 30 },
      },
      padding: [12, 22, 0, 4],
      series: [{}, ...p.series.map((s) => seriesOpts(s, p.height))],
      plugins: [tooltipPlugin(p.series, xKind)],
      hooks: {
        setSelect: [
          (u) => {
            if (!p.onZoom || u.select.width < 5) return;
            const a = u.posToVal(u.select.left, "x"), b = u.posToVal(u.select.left + u.select.width, "x");
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            p.onZoom(a, b);
          },
        ],
      },
    };
    const u = new uPlot(opts, data(), el.current);
    plot.current = u;
    p.onReady?.(u);
    const ro = new ResizeObserver(() => {
      if (el.current && el.current.clientWidth) u.setSize({ width: el.current.clientWidth, height: p.height });
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      u.destroy();
      plot.current = null;
      p.onReady?.(null);
    };
  }, [structure]);

  useEffect(() => {
    plot.current?.setData(data(), true);
  }, [p.x, p.ys, p.xRange?.[0], p.xRange?.[1]]);

  return <div class="chart" ref={el} />;
}

export function Legend(props: { items: { label: string; color: string; dash?: boolean; off?: boolean }[]; onToggle?: (i: number) => void }) {
  return (
    <div class="chart-legend">
      {props.items.map((it, i) => (
        <span class={`it${it.off ? " off" : ""}`} onClick={() => props.onToggle?.(i)} key={it.label}>
          <span class={`sw${it.dash ? " dash" : ""}`} style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Tiny inline sparkline for measurement cards (SVG, no uPlot instance). */
export function Spark(props: { v: (number | null)[]; color?: string }) {
  const pts = props.v.map((y, i) => [i, y] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 3) return <svg class="spark" />;
  const ys = pts.map((p) => p[1]);
  const min = Math.min(...ys), max = Math.max(...ys), n = props.v.length - 1 || 1;
  const d = pts.map(([i, y], k) => `${k ? "L" : "M"}${((i / n) * 100).toFixed(1)},${(24 - ((y - min) / (max - min || 1)) * 22).toFixed(1)}`).join("");
  return (
    <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={props.color || "#55c7f7"} stroke-width="1.4" vector-effect="non-scaling-stroke" opacity=".85" />
    </svg>
  );
}
