// Pure wire-format helpers (no network, no DOM) - unit-tested in web/test.
import type { Day, Meta, Series } from "./api";

export function decodeSeries(buf: ArrayBuffer): Series {
  const dv = new DataView(buf);
  if (buf.byteLength < 8 || dv.getUint32(0, false) !== 0x53455231) throw new Error("bad series stream");
  const n = dv.getUint8(4);
  const rowBytes = dv.getUint16(6, true);
  const rows = Math.floor((buf.byteLength - 8) / rowBytes);
  const t: number[] = new Array(rows);
  const cols: (number | null)[][] = Array.from({ length: n }, () => new Array(rows));
  for (let r = 0, o = 8; r < rows; r++, o += rowBytes) {
    t[r] = dv.getUint32(o, true);
    for (let c = 0; c < n; c++) {
      const v = dv.getInt16(o + 4 + 2 * c, true);
      cols[c][r] = v === -32768 ? null : v;
    }
  }
  return { t, cols };
}

export function decodeDays(j: { cols: string[]; rows: number[][] }): Day[] {
  return j.rows.map((r) => Object.fromEntries(j.cols.map((c, i) => [c, r[i]])) as unknown as Day);
}

// ---------------------------------------------------------------- tiers ---
export type Agg = "mean" | "max" | "last";
const AGG_CODE: Record<Agg, number> = { mean: 0, max: 1, last: 2 };
export interface TierCol { id: string; agg: Agg; code: number; scale: number }

export function tierCols(meta: Meta, tier: 1 | 15): TierCol[] {
  const idx = new Map(meta.channels.map((c, i) => [c.id, i]));
  const t = tier === 1 ? meta.tiers.h1 : meta.tiers.h15;
  return t.channels.map((key, i) => {
    const [id, agg = "mean"] = key.split(":") as [string, Agg?];
    return { id, agg, code: idx.get(id)! | (AGG_CODE[agg] << 6), scale: t.scale[i] };
  });
}
