// History access in engineering units, with automatic tier selection.
import { api, tierCols, type Agg, type Day, type Meta } from "./api";
import { DAY, nowS, ymd } from "./time";

export type Res = "auto" | "1m" | "15m";
export interface Req { id: string; agg?: Agg }
export interface HistResult {
  t: number[];
  cols: (number | null)[][]; // per request, engineering units; null = missing
  tier: 1 | 15;
  missing: string[]; // requested ids not stored in this tier
}

export function pickTier(from: number, to: number, res: Res): 1 | 15 {
  if (res === "1m") return 1;
  if (res === "15m") return 15;
  return to - from <= 3 * DAY ? 1 : 15;
}

export async function history(meta: Meta, reqs: Req[], from: number, to: number, res: Res = "auto"): Promise<HistResult> {
  const tier = pickTier(from, to, res);
  const cols = tierCols(meta, tier);
  const found = reqs.map((r) => cols.find((c) => c.id === r.id && c.agg === (r.agg ?? (tier === 1 ? "mean" : c.agg))) ?? cols.find((c) => c.id === r.id));
  const missing = reqs.filter((_, i) => !found[i]).map((r) => r.id);
  const codes = [...new Set(found.filter(Boolean).map((c) => c!.code))];
  if (!codes.length) return { t: [], cols: reqs.map(() => []), tier, missing };
  const s = await api.series(tier, from, Math.min(to, nowS() + 60), codes);
  const out = found.map((c) => {
    if (!c) return s.t.map(() => null);
    const raw = s.cols[codes.indexOf(c.code)];
    return raw.map((x) => (x == null ? null : x * c.scale));
  });
  return { t: s.t, cols: out, tier, missing };
}

/** Daily summaries in [fromYmd, toYmd], always including today (partial). */
export function days(fromYmd: number, toYmd = ymd(nowS())): Promise<Day[]> {
  return api.days(fromYmd, toYmd);
}

/** Channels that have stored history (1-minute tier). */
export function storedIds(meta: Meta): Set<string> {
  return new Set(meta.tiers.h1.channels);
}
