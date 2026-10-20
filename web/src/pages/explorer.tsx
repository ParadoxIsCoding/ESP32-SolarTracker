import { useMemo, useRef, useState } from "preact/hooks";
import type uPlot from "uplot";
import { combine, correlation, indexed, integrateKWh, minMaxDownsample, normalise, stats } from "../analytics";
import type { Chan, Day } from "../api";
import { Chart, Legend, type AxisDef, type SeriesDef, type Style } from "../chart";
import { days as fetchDays, history, storedIds } from "../data";
import { fmtStr, scaleUnit } from "../format";
import { getState, loadPref, savePref, useStore } from "../state";
import {
  DAY, TZ, addMonths, dayStart, fmtDate, fmtDateTime, monthStart, nowS, yearStart, ymd, ymdToEpoch,
} from "../time";
import { Card, Empty, Icon, QualityBadge, Seg, download, useAsync } from "../ui";

const PALETTE = ["#55c7f7", "#a78bfa", "#fbbf24", "#34d399", "#f87171", "#f472b6", "#60a5fa", "#a3e635"];
const CH_COLOR: Record<string, string> = { ppv1: "#55c7f7", ppv2: "#a78bfa", ppv3: "#fbbf24", vpv1: "#55c7f7", vpv2: "#a78bfa", vpv3: "#fbbf24", ipv1: "#55c7f7", ipv2: "#a78bfa", ipv3: "#fbbf24" };
const MAX_SERIES = 8;

export type RangeKey = "live" | "15m" | "1h" | "6h" | "today" | "yesterday" | "7d" | "30d" | "month" | "lastmonth" | "year" | "all" | "custom";
const RANGES: [RangeKey, string][] = [
  ["live", "Live"], ["15m", "15 min"], ["1h", "1 h"], ["6h", "6 h"], ["today", "Today"], ["yesterday", "Yesterday"],
  ["7d", "7 days"], ["30d", "30 days"], ["month", "This month"], ["lastmonth", "Last month"], ["year", "This year"], ["all", "All time"], ["custom", "Custom"],
];
type ResKey = "auto" | "1m" | "15m" | "1d";
type Mode = "raw" | "norm" | "index";

export interface SeriesCfg { id: string; color: string; style: Style; show: boolean; derived?: { a: string; b: string; op: "diff" | "ratio" | "pctdiff" | "eff" } }
export interface View {
  id: string; name: string; series: SeriesCfg[]; range: RangeKey; from?: number; to?: number;
  res: ResKey; mode: Mode; compare: boolean; pinned?: boolean; builtin?: boolean;
}

const mk = (ids: string[], style: Style = "line"): SeriesCfg[] =>
  ids.map((id, i) => ({ id, color: CH_COLOR[id] ?? PALETTE[i % PALETTE.length], style, show: true }));
export const BUILTIN: View[] = [
  { id: "b1", name: "Total generation", series: mk(["pac", "ppv"]), range: "today", res: "auto", mode: "raw", compare: true, builtin: true },
  { id: "b2", name: "All MPPT powers", series: mk(["ppv1", "ppv2", "ppv3"]), range: "today", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b3", name: "All MPPT voltages", series: mk(["vpv1", "vpv2", "vpv3"]), range: "today", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b4", name: "All MPPT currents", series: mk(["ipv1", "ipv2", "ipv3"]), range: "today", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b5", name: "DC input vs AC output", series: mk(["ppv", "pac"]), range: "today", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b6", name: "Grid voltage and frequency", series: mk(["vac", "fac"]), range: "today", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b7", name: "Output vs temperature", series: mk(["pac", "tinv"]), range: "7d", res: "auto", mode: "raw", compare: false, builtin: true },
  { id: "b8", name: "Daily energy production", series: mk(["eac_today"], "bars"), range: "30d", res: "1d", mode: "raw", compare: false, builtin: true },
  { id: "b9", name: "Conversion efficiency & losses", range: "today", res: "auto", mode: "raw", compare: false, builtin: true, series: [
    ...mk(["ppv", "pac"]),
    { id: "pac_eff_ppv", color: "#34d399", style: "line", show: true, derived: { a: "pac", b: "ppv", op: "eff" } },
    { id: "ppv_diff_pac", color: "#f87171", style: "area", show: true, derived: { a: "ppv", b: "pac", op: "diff" } },
  ] },
];

// Daily-summary equivalents for long ranges (labelled clearly).
const DAILY: Record<string, { col: keyof Day; scale: number; label: string }> = {
  eac_today: { col: "eac", scale: 0.1, label: "daily total" },
  epv1_today: { col: "epv1", scale: 0.1, label: "daily total" },
  epv2_today: { col: "epv2", scale: 0.1, label: "daily total" },
  epv3_today: { col: "epv3", scale: 0.1, label: "daily total" },
  eexp_today: { col: "eexp", scale: 0.1, label: "daily total" },
  eimp_today: { col: "eimp", scale: 0.1, label: "daily total" },
  eload_today: { col: "eload", scale: 0.1, label: "daily total" },
  pac: { col: "pacPeak", scale: 1, label: "daily peak" },
  ppv1: { col: "ppv1Peak", scale: 1, label: "daily peak" },
  ppv2: { col: "ppv2Peak", scale: 1, label: "daily peak" },
  ppv3: { col: "ppv3Peak", scale: 1, label: "daily peak" },
  tinv: { col: "tinvMax", scale: 0.1, label: "daily max" },
  vac: { col: "vacMax", scale: 0.1, label: "daily max" },
  fac: { col: "facMax", scale: 0.01, label: "daily max" },
};

export function rangeBounds(r: RangeKey, from?: number, to?: number): [number, number] {
  const n = nowS(), t = dayStart(n);
  switch (r) {
    case "live": return [n - 1800, n];
    case "15m": return [n - 900, n];
    case "1h": return [n - 3600, n];
    case "6h": return [n - 6 * 3600, n];
    case "today": return [t, n];
    case "yesterday": return [t - DAY, t - 1];
    case "7d": return [t - 6 * DAY, n];
    case "30d": return [t - 29 * DAY, n];
    case "month": return [monthStart(n), n];
    case "lastmonth": return [addMonths(n, -1), monthStart(n) - 1];
    case "year": return [yearStart(n), n];
    case "all": return [ymdToEpoch(20240101), n];
    case "custom": return [from ?? t, to ?? n];
  }
}

function resolveRes(res: ResKey, from: number, to: number, range: RangeKey): ResKey {
  if (range === "live") return "1m";
  if (res !== "auto") return res;
  const span = to - from;
  return span <= 3 * DAY ? "1m" : span <= 120 * DAY ? "15m" : "1d";
}

interface Plotted {
  t: number[];
  cols: (number | null)[][];
  defs: { cfg: SeriesCfg; chan?: Chan; label: string; unit: string; note?: string }[];
  xKind: "time" | "day";
  gap: number;
  notes: string[];
}

async function load(view: View, from: number, to: number): Promise<Plotted> {
  const st = getState();
  const meta = st.meta!;
  const res = resolveRes(view.res, from, to, view.range);
  const base = view.series.filter((s) => !s.derived);
  const chanOf = (id: string) => meta.channels.find((c) => c.id === id);
  const notes: string[] = [];
  let t: number[] = [];
  let cols: (number | null)[][] = [];
  let labels: string[] = base.map((s) => chanOf(s.id)?.name ?? s.id);
  let xKind: "time" | "day" = "time";
  let gap = 300;

  if (view.range === "live") {
    const b = st.buf;
    t = b.t.slice();
    cols = base.map((s) => { const i = meta.channels.findIndex((c) => c.id === s.id); return i >= 0 && b.v[i] ? b.v[i].slice() : t.map(() => null); });
    gap = 20;
    notes.push("Live: samples collected by this browser tab since it was opened (2 s resolution, not stored on the dongle).");
  } else if (res === "1d") {
    xKind = "day";
    const rows = await fetchDays(ymd(from), ymd(to));
    t = rows.map((d) => ymdToEpoch(d.date));
    cols = base.map((s) => { const m = DAILY[s.id]; return m ? rows.map((d) => (d[m.col] as number) * m.scale) : rows.map(() => null); });
    labels = base.map((s, i) => (DAILY[s.id] ? `${labels[i]} (${DAILY[s.id].label})` : labels[i]));
    const un = base.filter((s) => !DAILY[s.id]).map((s) => chanOf(s.id)?.name ?? s.id);
    if (un.length) notes.push(`No daily summary for: ${un.join(", ")}. Choose 1-minute or 15-minute resolution.`);
    gap = 0;
  } else {
    const h = await history(meta, base.map((s) => ({ id: s.id })), from, to, res === "1m" ? "1m" : "15m");
    t = h.t;
    cols = h.cols;
    gap = h.tier === 1 ? 180 : 2700;
    if (h.missing.length) notes.push(`Not stored as history (live only): ${h.missing.map((id) => chanOf(id)?.name ?? id).join(", ")}. Use the Live range to chart them.`);
    if (h.tier === 15) notes.push("15-minute averages. Pick a shorter range or 1-minute resolution (last ~26 days) for detail.");
  }

  // derived series
  const defs: Plotted["defs"] = base.map((s, i) => ({ cfg: s, chan: chanOf(s.id), label: labels[i], unit: chanOf(s.id)?.unit ?? "" }));
  for (const s of view.series.filter((x) => x.derived)) {
    const d = s.derived!;
    const ia = base.findIndex((x) => x.id === d.a), ib = base.findIndex((x) => x.id === d.b);
    if (ia < 0 || ib < 0) continue;
    cols.push(combine(cols[ia], cols[ib], d.op));
    const ua = defs[ia].unit;
    const name = d.op === "eff" ? `Efficiency (${defs[ia].label} ÷ ${defs[ib].label})`
      : d.a === "ppv" && d.b === "pac" && d.op === "diff" ? "Conversion loss (DC in − AC out)"
      : `${defs[ia].label} ${d.op === "diff" ? "−" : d.op === "ratio" ? "÷" : "% vs"} ${defs[ib].label}`;
    defs.push({ cfg: s, label: name, unit: d.op === "diff" ? (ua === defs[ib].unit ? ua : "") : d.op === "ratio" ? "" : "%", note: "calculated" });
    if (d.op === "eff") notes.push("Efficiency is only shown while DC input is above 300 W; below that the ratio is dominated by standby losses and measurement resolution.");
    if (d.op === "diff" && ua !== defs[ib].unit) notes.push(`"${name}" subtracts different units (${ua} − ${defs[ib].unit}); the result has no physical unit.`);
  }
  if (t.length > 4000) {
    const d = minMaxDownsample(t, cols, 3000);
    t = d.t; cols = d.cols;
    notes.push("Downsampled for display (min/max per bucket, so peaks and valleys are kept). Exports contain all points.");
  }
  return { t, cols, defs, xKind, gap, notes };
}

function useViews() {
  const [views, setViews] = useState<View[]>(loadPref("views", []));
  const save = (v: View[]) => { setViews(v); savePref("views", v); };
  return { views, save };
}

export function Explorer(p: { q: URLSearchParams }) {
  const s = useStore();
  const meta = s.meta!;
  const { views, save } = useViews();
  const initial = (): View => {
    const vid = p.q.get("v");
    const byId = vid && [...views, ...BUILTIN].find((v) => v.id === vid);
    if (byId) return structuredClone(byId);
    const ids = p.q.get("s")?.split(",").filter((id) => meta.channels.some((c) => c.id === id));
    const r = (p.q.get("r") as RangeKey) || undefined;
    if (ids?.length) return { id: "", name: "Untitled", series: mk(ids.slice(0, MAX_SERIES)), range: r ?? "today", res: "auto", mode: "raw", compare: false };
    const def = loadPref<string | null>("defaultView", null);
    return structuredClone([...views, ...BUILTIN].find((v) => v.id === def) ?? BUILTIN[0]);
  };
  const [view, setView] = useState<View>(initial);
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [q, setQ] = useState("");
  const [full, setFull] = useState(false);
  const [derive, setDerive] = useState({ a: "", b: "", op: "diff" as "diff" | "ratio" | "pctdiff" | "eff" });
  const plotRef = useRef<uPlot | null>(null);
  const upd = (patch: Partial<View>) => { setView({ ...view, ...patch }); if (patch.range || patch.from || patch.res) setZoom(null); };

  const [from, to] = rangeBounds(view.range, view.from, view.to);
  const span = to - from;
  const live = view.range === "live";
  const key = JSON.stringify([view.series.map((x) => [x.id, x.derived]), view.range, view.res, view.from, view.to]);
  const data = useAsync(() => load(view, from, to), [key, live ? s.tick : Math.floor(nowS() / (span <= DAY ? 60 : 600))]);
  const prev = useAsync(async () => {
    if (!view.compare || live) return null;
    const shift = span <= DAY + 60 ? DAY : Math.ceil(span / DAY) * DAY;
    const r = await load({ ...view, series: view.series.filter((x) => !x.derived).slice(0, 4) }, from - shift, to - shift);
    return { ...r, t: r.t.map((x) => x + shift), shift };
  }, [key, view.compare]);

  const stored = storedIds(meta);
  const res = resolveRes(view.res, from, to, view.range);
  const d = data.data;

  // ----- build chart model -----
  const model = useMemo(() => {
    if (!d || !d.t.length) return null;
    const units: string[] = [];
    const cols = d.cols.map((c) => (view.mode === "norm" ? normalise(c) : view.mode === "index" ? indexed(c) : c));
    const series: SeriesDef[] = [];
    const axisFor = (unit: string) => {
      const u = view.mode === "raw" ? unit || "value" : "%";
      if (!units.includes(u)) units.push(u);
      return u;
    };
    d.defs.forEach((def, i) => {
      const unit = view.mode === "raw" ? def.unit : "%";
      series.push({
        label: def.label, color: def.cfg.color, axis: axisFor(def.unit), style: def.cfg.style, show: def.cfg.show,
        width: 2, fmt: (v) => (v == null ? "—" : view.mode === "raw" ? fmtStr(v, unit) : `${v.toFixed(1)}%`),
      });
      void i;
    });
    let ys = cols;
    let x = d.t;
    const pv = prev.data;
    // Only overlay when the previous-period data matches the current series
    // (both load asynchronously, so one can be stale for a moment).
    const pvOk = pv && pv.t.length && pv.defs.every((x, k) => d.defs[k] && x.cfg.id === d.defs[k].cfg.id);
    if (pv && pvOk) {
      // merge timestamps of both datasets
      const all = [...new Set([...d.t, ...pv.t])].sort((a, b) => a - b);
      const ix = new Map(all.map((t, i) => [t, i]));
      const remap = (t: number[], c: (number | null)[]) => { const o: (number | null)[] = all.map(() => null); t.forEach((tt, k) => (o[ix.get(tt)!] = c[k])); return o; };
      ys = cols.map((c) => remap(d.t, c));
      pv.cols.forEach((c, k) => {
        const def = d.defs[k];
        const cc = view.mode === "norm" ? normalise(c) : view.mode === "index" ? indexed(c) : c;
        ys.push(remap(pv.t, cc));
        series.push({ label: `${def.label} (previous)`, color: def.cfg.color, axis: axisFor(def.unit), dash: true, width: 1.5, show: def.cfg.show,
          fmt: series[k].fmt });
      });
      x = all;
    }
    const axes: AxisDef[] = units.map((u, i) => {
      const vals = series.flatMap((sd, k) => (sd.axis === u ? ys[k] : [])).filter((v): v is number => v != null);
      const maxAbs = vals.length ? Math.max(...vals.map(Math.abs)) : 0;
      const sc = view.mode === "raw" ? scaleUnit(u, maxAbs) : { unit: "%", div: 1 };
      return { key: u, label: sc.unit, side: i === 0 ? "left" : "right", fmt: (v) => {
        const y = v / sc.div;
        return Math.abs(y) >= 100 ? y.toFixed(0) : Math.abs(y) >= 10 ? y.toFixed(1).replace(/\.0$/, "") : y.toFixed(2).replace(/0$/, "");
      } };
    });
    return { x, ys, series, axes, units };
  }, [d, prev.data, view.mode, view.series.map((x) => x.color + x.style + x.show).join()]);

  // ----- stats for the visible window -----
  const [w0, w1] = zoom ?? [from, to];
  const table = d?.defs.map((def, i) => {
    const st = stats(d.t, d.cols[i], w0, w1);
    const inWin = d.t.map((t, k) => (t >= w0 && t <= w1 ? d.cols[i][k] : null));
    const kwh = def.unit === "W" && res !== "1d" ? integrateKWh(d.t, inWin, d.gap || 180) : null;
    return { def, st, kwh };
  });
  const corr = d && d.defs.length >= 2 ? correlation(
    d.cols[0].map((v, k) => (d.t[k] >= w0 && d.t[k] <= w1 ? v : null)),
    d.cols[1].map((v, k) => (d.t[k] >= w0 && d.t[k] <= w1 ? v : null))) : null;

  // ----- actions -----
  const toggle = (id: string) => {
    const has = view.series.find((x) => x.id === id && !x.derived);
    if (has) upd({ series: view.series.filter((x) => x !== has && !(x.derived && (x.derived.a === id || x.derived.b === id))) });
    else if (view.series.length < MAX_SERIES) {
      const used = new Set(view.series.map((x) => x.color));
      const color = CH_COLOR[id] && !used.has(CH_COLOR[id]) ? CH_COLOR[id] : PALETTE.find((c) => !used.has(c)) ?? PALETTE[0];
      upd({ series: [...view.series, { id, color, style: "line", show: true }] });
    }
  };
  const setSeries = (i: number, patch: Partial<SeriesCfg>) => upd({ series: view.series.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const exportCsv = () => {
    if (!d) return;
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const head = ["time_brisbane", "epoch_utc", ...d.defs.map((x) => `${x.label}${x.unit ? ` [${x.unit}]` : ""}`)];
    const lines = [head.map((h) => `"${h.replace(/"/g, "'")}"`).join(",")];
    d.t.forEach((t, k) => lines.push([fmt.format(t * 1000).replace(",", ""), t, ...d.cols.map((c) => (c[k] == null ? "" : +(c[k] as number).toFixed(4)))].join(",")));
    download(`solar_${view.name.replace(/\W+/g, "_")}_${ymd(from)}-${ymd(to)}.csv`, lines.join("\n"));
  };
  const exportPng = () => {
    const u = plotRef.current;
    if (!u) return;
    const src = u.ctx.canvas, pad = 48 * devicePixelRatio;
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height + pad;
    const g = c.getContext("2d")!;
    g.fillStyle = "#151e2b"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#f1f5f9"; g.font = `${15 * devicePixelRatio}px -apple-system, sans-serif`;
    g.fillText(`${view.name} · ${fmtDate(from)} – ${fmtDate(to)}${view.mode !== "raw" ? " · normalised" : ""}`, 12 * devicePixelRatio, 28 * devicePixelRatio);
    g.drawImage(src, 0, pad);
    c.toBlob((b) => b && download(`solar_${ymd(from)}.png`, b, "image/png"));
  };
  const panBy = (f: number) => {
    const [a, b] = zoom ?? [from, to];
    const sh = (b - a) * f;
    setZoom([Math.max(from, a + sh), Math.min(to, b + sh)]);
  };
  const saveView = (asNew: boolean) => {
    const name = prompt("Name this view", asNew || !view.id || view.builtin ? `${view.name}${view.builtin ? " (copy)" : ""}` : view.name);
    if (!name) return;
    const v: View = { ...view, name, builtin: false, id: asNew || !view.id || view.builtin ? Math.random().toString(36).slice(2, 9) : view.id };
    save([...views.filter((x) => x.id !== v.id), v]);
    setView(v);
  };

  // ----- picker -----
  const cats = meta.categories.map((c) => ({
    ...c,
    chans: meta.channels.filter((ch) => ch.cat === c.id && ch.kind !== "status" && (!q || `${ch.name} ${ch.id} ${ch.unit}`.toLowerCase().includes(q.toLowerCase()))),
  })).filter((c) => c.chans.length);
  const liveIdx = (id: string) => meta.channels.findIndex((c) => c.id === id);
  const nonStoredSelected = view.series.some((x) => !x.derived && !stored.has(x.id) && !(res === "1d" && DAILY[x.id]));

  return (
    <div class="ex">
      <Card class="picker">
        <input class="input" style={{ width: "100%" }} placeholder={`Search ${meta.channels.length} measurements`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <div class="small faint" style={{ margin: "8px 4px 0" }}>{view.series.length}/{MAX_SERIES} selected</div>
        {cats.map((c) => (
          <div key={c.id}>
            <div class="pick-cat">{c.name}</div>
            {c.chans.map((ch) => {
              const sel = view.series.find((x) => x.id === ch.id && !x.derived);
              const lv = s.live?.v[liveIdx(ch.id)];
              const hist = stored.has(ch.id) || (DAILY[ch.id] && res === "1d");
              return (
                <div key={ch.id} class={`pick ${sel ? "on" : ""} ${!hist && !live ? "dis" : ""}`} onClick={() => toggle(ch.id)} title={`${ch.desc}${hist ? "" : " (live only - not stored)"}`}>
                  <span class="box" style={sel ? { background: sel.color } : {}} />
                  <span class="nm">{ch.name}</span>
                  <span class="lv num">{lv == null ? (hist ? ch.unit : "live only") : fmtStr(lv, ch.unit)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </Card>

      <div class="grid" style={{ gap: 16 }}>
        <Card>
          <div class="row wrap between" style={{ gap: 10, marginBottom: 12 }}>
            <div class="row wrap" style={{ gap: 8 }}>
              <select class="input" value={view.id || ""} onChange={(e) => {
                const id = (e.target as HTMLSelectElement).value;
                const v = [...views, ...BUILTIN].find((x) => x.id === id);
                if (v) { setView(structuredClone(v)); setZoom(null); }
              }}>
                {!view.id && <option value="">Untitled view</option>}
                <optgroup label="Saved views">{views.map((v) => <option value={v.id} key={v.id}>{v.name}{v.pinned ? " (pinned)" : ""}</option>)}</optgroup>
                <optgroup label="Presets">{BUILTIN.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</optgroup>
              </select>
              <button class="btn sm" onClick={() => saveView(false)} title="Save view"><Icon n="save" size={14} />Save</button>
              <button class="btn sm ghost" onClick={() => saveView(true)} title="Save as a copy"><Icon n="copy" size={14} />Duplicate</button>
              {view.id && !view.builtin && <>
                <button class={`btn sm ghost`} onClick={() => { const v = { ...view, pinned: !view.pinned }; save(views.map((x) => (x.id === v.id ? v : x))); setView(v); }} title="Show on Overview"><Icon n="pin" size={14} />{view.pinned ? "Unpin" : "Pin to overview"}</button>
                <button class="btn sm ghost" onClick={() => { savePref("defaultView", view.id); }} title="Open this view by default">Set default</button>
                <button class="btn sm ghost" onClick={() => { if (confirm(`Delete "${view.name}"?`)) { save(views.filter((x) => x.id !== view.id)); setView({ ...view, id: "", name: "Untitled" }); } }} title="Delete view"><Icon n="trash" size={14} /></button>
              </>}
            </div>
            <div class="row" style={{ gap: 6 }}>
              <button class="btn sm ghost" onClick={exportCsv} disabled={!d?.t.length}><Icon n="download" size={14} />CSV</button>
              <button class="btn sm ghost" onClick={exportPng} disabled={!model}><Icon n="download" size={14} />PNG</button>
            </div>
          </div>
          <div class="row wrap" style={{ gap: 8 }}>
            <Seg value={view.range} options={RANGES} onChange={(r) => upd({ range: r, ...(r === "custom" ? { from, to } : {}) })} />
          </div>
          {view.range === "custom" && (
            <div class="row wrap" style={{ gap: 10, marginTop: 10 }}>
              <label class="f">From<input class="input" type="datetime-local" value={toLocalInput(view.from ?? from)} onChange={(e) => upd({ from: fromLocalInput((e.target as HTMLInputElement).value) })} /></label>
              <label class="f">To<input class="input" type="datetime-local" value={toLocalInput(view.to ?? to)} onChange={(e) => upd({ to: fromLocalInput((e.target as HTMLInputElement).value) })} /></label>
            </div>
          )}
          <div class="row wrap" style={{ gap: 8, marginTop: 10 }}>
            <span class="small muted">Resolution</span>
            <Seg value={view.res} options={[["auto", `Auto (${res === "1m" ? "1 min" : res === "15m" ? "15 min" : "daily"})`], ["1m", "1 min"], ["15m", "15 min"], ["1d", "Daily"]]} onChange={(r) => upd({ res: r })} />
            <span class="small muted">Scale</span>
            <Seg value={view.mode} options={[["raw", "Units"], ["norm", "0–100%"], ["index", "Indexed"]]} onChange={(m) => upd({ mode: m })} />
            {!live && <label class="row small muted" style={{ cursor: "pointer" }}><input type="checkbox" checked={view.compare} onChange={() => upd({ compare: !view.compare })} />Compare previous period</label>}
          </div>
        </Card>

        <Card class={full ? "fs" : ""}>
          <div class="row between wrap" style={{ marginBottom: 8, gap: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16 }}>{view.name}</h3>
              <p class="sub" style={{ margin: 0 }}>{zoom ? `${fmtDateTime(zoom[0])} – ${fmtDateTime(zoom[1])} (zoomed)` : `${fmtDateTime(from)} – ${fmtDateTime(to)}`}</p>
            </div>
            <div class="row" style={{ gap: 4 }}>
              <button class="btn sm ghost icon" onClick={() => panBy(-0.5)} title="Pan left" disabled={!zoom}><Icon n="left" size={15} /></button>
              <button class="btn sm ghost icon" onClick={() => panBy(0.5)} title="Pan right" disabled={!zoom}><Icon n="right" size={15} /></button>
              <button class="btn sm ghost" onClick={() => setZoom(null)} disabled={!zoom}><Icon n="reset" size={14} />Reset zoom</button>
              <button class="btn sm ghost icon" onClick={() => setFull(!full)} title="Full screen"><Icon n={full ? "x" : "expand"} size={15} /></button>
            </div>
          </div>
          {view.mode !== "raw" && <div class="banner info" style={{ marginBottom: 10 }}>{view.mode === "norm" ? "Normalised: each series is scaled 0–100% between its own minimum and maximum in this range. Shapes are comparable; absolute values aren't." : "Indexed: each series is shown relative to its first value (= 100)."}</div>}
          {model && model.units.length > 2 && view.mode === "raw" && <div class="banner warn" style={{ marginBottom: 10 }}>{model.units.length} different units are plotted on separate axes. Switch to 0–100% to compare shapes more easily.</div>}
          {!view.series.length ? <Empty h={full ? 500 : 380}>Select up to {MAX_SERIES} measurements on the left to chart them.</Empty> :
            data.err ? <Empty h={380}>Could not load data: {data.err}</Empty> :
            !model ? <Empty h={380}>{data.loading ? "Loading…" : live ? "Collecting live samples… keep this tab open." : "No data recorded for this range yet. History starts when the dongle first logs (while the inverter is producing)."}</Empty> : (
              <>
                <Chart height={full ? Math.max(420, innerHeight - 260) : 380} x={model.x} ys={model.ys} series={model.series} axes={model.axes}
                  xKind={d!.xKind} gapSec={d!.gap} onZoom={(a, b) => setZoom([a, b])} onReady={(u) => (plotRef.current = u)}
                  xRange={zoom ?? undefined} />
                <Legend items={model.series.map((x) => ({ label: x.label, color: x.color, dash: x.dash, off: x.show === false }))}
                  onToggle={(i) => i < view.series.length && setSeries(i, { show: !view.series[i].show })} />
              </>
            )}
          <p class="foot-note" style={{ marginBottom: 0 }}>Drag across the chart to zoom. Lines break where no data was recorded (inverter off or offline) — gaps are never filled in.</p>
        </Card>

        {(d?.notes.length || nonStoredSelected) ? <div class="banner info">{d?.notes.map((n) => <div key={n}>{n}</div>)}</div> : null}

        <div class="grid g2">
          <Card title="Series" sub="Colour, style and visibility">
            <div class="serieslist">
              {view.series.map((x, i) => {
                const ch = meta.channels.find((c) => c.id === x.id);
                return (
                  <div class="s" key={i}>
                    <input type="color" class="colorin" value={x.color} onInput={(e) => setSeries(i, { color: (e.target as HTMLInputElement).value })} aria-label="Colour" />
                    <span class="grow small">{x.derived ? d?.defs[i]?.label ?? "Derived" : ch?.name}{x.derived && <span class="faint"> · calculated</span>}</span>
                    {ch && <QualityBadge q={ch.quality} />}
                    <select class="input" style={{ padding: "3px 6px", fontSize: 12 }} value={x.style} onChange={(e) => setSeries(i, { style: (e.target as HTMLSelectElement).value as Style })}>
                      <option value="line">Line</option><option value="area">Area</option><option value="bars">Bars</option><option value="step">Step</option>
                    </select>
                    <button class="btn sm ghost" onClick={() => setSeries(i, { show: !x.show })}>{x.show ? "Hide" : "Show"}</button>
                    <button class="btn sm ghost icon" onClick={() => upd({ series: view.series.filter((_, k) => k !== i) })} aria-label="Remove"><Icon n="x" size={14} /></button>
                  </div>
                );
              })}
              {!view.series.length && <div class="faint small">No series selected.</div>}
            </div>
            {view.series.filter((x) => !x.derived).length >= 2 && view.series.length < MAX_SERIES && (
              <div class="row wrap" style={{ gap: 6, marginTop: 12 }}>
                <span class="small muted">Add calculated</span>
                <select class="input" style={{ fontSize: 12, padding: "4px 6px" }} value={derive.a} onChange={(e) => setDerive({ ...derive, a: (e.target as HTMLSelectElement).value })}>
                  <option value="">A…</option>{view.series.filter((x) => !x.derived).map((x) => <option value={x.id} key={x.id}>{meta.channels.find((c) => c.id === x.id)?.name}</option>)}
                </select>
                <select class="input" style={{ fontSize: 12, padding: "4px 6px" }} value={derive.op} onChange={(e) => setDerive({ ...derive, op: (e.target as HTMLSelectElement).value as "diff" })}>
                  <option value="diff">A − B</option><option value="ratio">A ÷ B</option><option value="pctdiff">% difference</option><option value="eff">Efficiency A ÷ B (%)</option>
                </select>
                <select class="input" style={{ fontSize: 12, padding: "4px 6px" }} value={derive.b} onChange={(e) => setDerive({ ...derive, b: (e.target as HTMLSelectElement).value })}>
                  <option value="">B…</option>{view.series.filter((x) => !x.derived).map((x) => <option value={x.id} key={x.id}>{meta.channels.find((c) => c.id === x.id)?.name}</option>)}
                </select>
                <button class="btn sm" disabled={!derive.a || !derive.b || derive.a === derive.b} onClick={() => {
                  const used = new Set(view.series.map((x) => x.color));
                  upd({ series: [...view.series, { id: `${derive.a}_${derive.op}_${derive.b}`, color: PALETTE.find((c) => !used.has(c)) ?? "#94a3b8", style: "line", show: true, derived: { ...derive } }] });
                }}><Icon n="plus" size={14} />Add</button>
              </div>
            )}
          </Card>

          <Card title="Statistics" sub={zoom ? "Zoomed window" : "Whole range"}>
            {!table?.length || !d?.t.length ? <div class="faint small">No data.</div> : (
              <div class="scroll-x">
                <table class="t">
                  <thead><tr><th>Series</th><th class="r">Min</th><th class="r">Mean</th><th class="r">Max</th><th class="r">Peak at</th><th class="r">Energy</th></tr></thead>
                  <tbody>
                    {table.map(({ def, st, kwh }) => (
                      <tr key={def.label}>
                        <td><span class="dot" style={{ background: def.cfg.color, marginRight: 6 }} />{def.label}</td>
                        <td class="r num">{fmtStr(st.min, def.unit)}</td>
                        <td class="r num">{fmtStr(st.mean, def.unit)}</td>
                        <td class="r num">{fmtStr(st.max, def.unit)}</td>
                        <td class="r num">{st.maxAt ? (d.xKind === "day" ? fmtDate(st.maxAt + 43200) : fmtDateTime(st.maxAt)) : "—"}</td>
                        <td class="r num" title="Time-weighted integral of this power series (calculated in the browser)">{kwh == null ? "—" : `${kwh.toFixed(2)} kWh`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {corr && (
              <p class="small" style={{ marginBottom: 0 }}>
                <span class="muted">Correlation ({d!.defs[0].label} vs {d!.defs[1].label}): </span>
                {corr.r == null ? <span class="faint">not enough overlapping data</span> : <b class="num">r = {corr.r.toFixed(3)}</b>}
                <span class="faint"> · {corr.n} paired samples. Correlation doesn't imply cause — e.g. output and temperature both follow the sun.</span>
              </p>
            )}
            <p class="foot-note" style={{ marginBottom: 0 }}>The energy column integrates power over time (calculated). For official totals, use the inverter's own counters on the Energy page.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function toLocalInput(e: number) {
  const d = new Date((e + 10 * 3600) * 1000);
  return d.toISOString().slice(0, 16);
}
function fromLocalInput(s: string) {
  return Date.parse(s + ":00Z") / 1000 - 10 * 3600;
}

/** Saved views pinned to the Overview page. */
export function PinnedViews() {
  const views = loadPref<View[]>("views", []).filter((v) => v.pinned);
  if (!views.length) return null;
  return (
    <div class="grid g2">
      {views.map((v) => <PinnedChart v={v} key={v.id} />)}
    </div>
  );
}

function PinnedChart(p: { v: View }) {
  const [from, to] = rangeBounds(p.v.range, p.v.from, p.v.to);
  const data = useAsync(() => load(p.v, from, to), [p.v.id, Math.floor(nowS() / 120)]);
  const d = data.data;
  const units = d ? [...new Set(d.defs.map((x) => x.unit || "v"))].slice(0, 2) : [];
  const keep = d ? d.defs.map((x) => units.includes(x.unit || "v")) : [];
  return (
    <Card title={p.v.name} sub={RANGES.find((r) => r[0] === p.v.range)?.[1]} right={<a class="small" href={`#/explorer?v=${p.v.id}`}>Open</a>}>
      {!d?.t.length ? <Empty h={200}>{data.loading ? "Loading…" : "No data yet"}</Empty> : (
        <Chart height={200} x={d.t} ys={d.cols.filter((_, i) => keep[i])} xKind={d.xKind} gapSec={d.gap}
          axes={units.map((u, i) => ({ key: u, label: u, side: i ? "right" : "left", fmt: (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(Math.abs(v) < 10 ? 1 : 0)) }))}
          series={d.defs.filter((_, i) => keep[i]).map((x) => ({ label: x.label, color: x.cfg.color, axis: x.unit || "v", style: x.cfg.style, fmt: (v) => fmtStr(v, x.unit) }))} />
      )}
    </Card>
  );
}
