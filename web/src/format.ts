// Unit-aware number formatting. Values are never invented: null -> "—".
export interface Fmt { v: string; u: string }

export function scaleUnit(unit: string, maxAbs: number): { unit: string; div: number } {
  if (unit === "W" && maxAbs >= 1000) return { unit: "kW", div: 1000 };
  if (unit === "VA" && maxAbs >= 1000) return { unit: "kVA", div: 1000 };
  if (unit === "var" && maxAbs >= 1000) return { unit: "kvar", div: 1000 };
  if (unit === "kWh" && maxAbs >= 10000) return { unit: "MWh", div: 1000 };
  if (unit === "kΩ" && maxAbs >= 10000) return { unit: "MΩ", div: 1000 };
  return { unit, div: 1 };
}

function digits(unit: string, x: number): number {
  const a = Math.abs(x);
  switch (unit) {
    case "kW": case "kVA": case "kvar": return 2;
    case "MWh": return a >= 100 ? 1 : 2;
    case "kWh": return a >= 100 ? 0 : 1;
    case "W": case "VA": case "var": case "kΩ": case "s": case "mA": return a < 10 ? 1 : 0;
    case "V": case "°C": case "A": return 1;
    case "Hz": return 2;
    case "%": return a < 100 && !Number.isInteger(x) ? 1 : 0;
    case "h": return 0;
    default: return Number.isInteger(x) ? 0 : 1;
  }
}

export function fmtValue(x: number | null | undefined, unit: string): Fmt {
  if (x == null || !isFinite(x)) return { v: "—", u: "" };
  const s = scaleUnit(unit, Math.abs(x));
  const y = x / s.div;
  return { v: y.toLocaleString("en-AU", { minimumFractionDigits: digits(s.unit, y), maximumFractionDigits: digits(s.unit, y) }), u: s.unit };
}
export const fmtStr = (x: number | null | undefined, unit: string) => {
  const f = fmtValue(x, unit);
  return f.u ? `${f.v} ${f.u}` : f.v;
};
export const fmtPct = (x: number | null | undefined, d = 1) =>
  x == null || !isFinite(x) ? "—" : `${x.toFixed(d)}%`;
export const fmtBytes = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`;

export const STATUS: Record<number, { label: string; tone: "ok" | "warn" | "err" | "" }> = {
  0: { label: "Waiting", tone: "warn" },
  1: { label: "Normal", tone: "ok" },
  3: { label: "Fault", tone: "err" },
};
export const statusOf = (s: number | null | undefined, link: boolean) =>
  !link || s == null ? { label: "Offline", tone: "" as const } : STATUS[s] ?? { label: `Code ${s}`, tone: "warn" as const };
