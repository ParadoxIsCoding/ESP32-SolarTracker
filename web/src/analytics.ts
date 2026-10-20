// Pure calculation helpers (unit-tested in web/test). Every function treats
// null as "no data" - never as zero - and documents its assumptions.

export interface Stats {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  minAt: number | null;
  maxAt: number | null;
}

export function stats(t: number[], v: (number | null)[], from = -Infinity, to = Infinity): Stats {
  let n = 0, sum = 0, min: number | null = null, max: number | null = null, minAt: number | null = null, maxAt: number | null = null;
  for (let i = 0; i < t.length; i++) {
    const x = v[i];
    if (x == null || t[i] < from || t[i] > to) continue;
    n++;
    sum += x;
    if (min == null || x < min) { min = x; minAt = t[i]; }
    if (max == null || x > max) { max = x; maxAt = t[i]; }
  }
  return { n, min, max, mean: n ? sum / n : null, minAt, maxAt };
}

/**
 * Time-weighted energy (kWh) from a power series in W, trapezoidal rule.
 * Intervals longer than `maxGap` seconds (offline periods) contribute
 * nothing rather than being bridged. Labelled "calculated" in the UI; the
 * inverter's own counters are preferred wherever they exist.
 */
export function integrateKWh(t: number[], w: (number | null)[], maxGap = 180): number | null {
  let wh = 0, used = false;
  for (let i = 1; i < t.length; i++) {
    const a = w[i - 1], b = w[i], dt = t[i] - t[i - 1];
    if (a == null || b == null || dt <= 0 || dt > maxGap) continue;
    wh += ((a + b) / 2) * (dt / 3600);
    used = true;
  }
  return used ? wh / 1000 : null;
}

/** Pearson correlation over timestamps where both series have values. */
export function correlation(a: (number | null)[], b: (number | null)[]): { r: number | null; n: number } {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x == null || y == null) continue;
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 10) return { r: null, n };
  const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return { r: null, n };
  return { r: cov / Math.sqrt(va * vb), n };
}

/** Min-max normalisation to 0-100 %. */
export function normalise(v: (number | null)[]): (number | null)[] {
  const xs = v.filter((x): x is number => x != null);
  if (!xs.length) return v.map(() => null);
  const lo = Math.min(...xs), hi = Math.max(...xs), span = hi - lo || 1;
  return v.map((x) => (x == null ? null : ((x - lo) / span) * 100));
}

/** Indexed to the first non-null value = 100. */
export function indexed(v: (number | null)[]): (number | null)[] {
  const base = v.find((x) => x != null && x !== 0);
  if (base == null) return v.map(() => null);
  return v.map((x) => (x == null ? null : (x / base) * 100));
}

export function combine(a: (number | null)[], b: (number | null)[], op: "diff" | "ratio" | "pctdiff" | "eff"): (number | null)[] {
  return a.map((x, i) => {
    const y = b[i];
    if (op === "eff") return efficiency(x, y);
    if (x == null || y == null) return null;
    if (op === "diff") return x - y;
    if (op === "ratio") return Math.abs(y) < 1e-9 ? null : x / y;
    return Math.abs(y) < 1e-9 ? null : ((x - y) / Math.abs(y)) * 100;
  });
}

/**
 * DC-to-AC conversion efficiency. Below `minDcW` the ratio is dominated by
 * measurement resolution and standby losses, so it is reported as null.
 */
export function efficiency(acW: number | null, dcW: number | null, minDcW = 300): number | null {
  if (acW == null || dcW == null || dcW < minDcW) return null;
  const e = (acW / dcW) * 100;
  return e > 0 && e <= 100 ? e : null;
}

/** Share of each MPPT in the total; null when there is no meaningful total. */
export function shares(p: (number | null)[], minTotal = 50): (number | null)[] {
  const total = p.reduce<number>((s, x) => s + (x ?? 0), 0);
  if (total < minTotal || p.some((x) => x == null)) return p.map(() => null);
  return p.map((x) => ((x as number) / total) * 100);
}

/** Percent change, null if the base is missing or ~0. */
export function pctChange(now: number | null, base: number | null): number | null {
  if (now == null || base == null || Math.abs(base) < 1e-9) return null;
  return ((now - base) / Math.abs(base)) * 100;
}

/** Sum of daily inverter-counter energy (0.1 kWh units) for days in [a,b]. */
export function sumDays(days: { date: number; eac: number }[], a: number, b: number): { kwh: number | null; days: number } {
  let s = 0, n = 0;
  for (const d of days) if (d.date >= a && d.date <= b) { s += d.eac; n++; }
  return { kwh: n ? s / 10 : null, days: n };
}

/** Rolling mean over `k` points (centred=false). */
export function rolling(v: (number | null)[], k: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < v.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - k + 1); j <= i; j++) if (v[j] != null) { s += v[j] as number; n++; }
    out.push(n ? s / n : null);
  }
  return out;
}

/** Downsample keeping min and max per bucket (preserves peaks/valleys). */
export function minMaxDownsample(t: number[], cols: (number | null)[][], maxPoints: number) {
  if (t.length <= maxPoints) return { t, cols };
  const buckets = Math.floor(maxPoints / 2);
  const size = t.length / buckets;
  const keep = new Set<number>();
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.min(t.length, Math.floor((b + 1) * size));
    keep.add(s);
    for (const c of cols) {
      let mi = -1, ma = -1;
      for (let i = s; i < e; i++) {
        const x = c[i];
        if (x == null) continue;
        if (mi < 0 || x < (c[mi] as number)) mi = i;
        if (ma < 0 || x > (c[ma] as number)) ma = i;
      }
      if (mi >= 0) keep.add(mi);
      if (ma >= 0) keep.add(ma);
    }
  }
  const idx = [...keep].sort((a, b) => a - b);
  return { t: idx.map((i) => t[i]), cols: cols.map((c) => idx.map((i) => c[i])) };
}

/**
 * Value of energy at a two-tier daily feed-in tariff: the first `tierKwh`
 * per day at `rate1`, the rest at `rate2` (tierKwh = 0 -> single rate).
 * Treats every generated kWh as exported, so it is an upper bound on
 * feed-in credit, not a saving.
 */
export function feedInValue(dailyKwh: number[], rate1: number, rate2: number, tierKwh: number): number {
  let v = 0;
  for (const k of dailyKwh) {
    if (!(k > 0)) continue;
    v += tierKwh > 0 ? Math.min(k, tierKwh) * rate1 + Math.max(0, k - tierKwh) * rate2 : k * rate1;
  }
  return v;
}
