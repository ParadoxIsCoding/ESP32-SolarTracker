// Australia/Brisbane is UTC+10 with no daylight saving, so day boundaries
// are plain arithmetic. All storage is UTC epoch seconds.
export const TZ = "Australia/Brisbane";
export const OFFSET = 10 * 3600;
export const DAY = 86400;

export const nowS = () => Date.now() / 1000;
export const dayStart = (e: number) => Math.floor((e + OFFSET) / DAY) * DAY - OFFSET;
export const ymd = (e: number) => {
  const d = new Date((e + OFFSET) * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};
export const ymdToEpoch = (n: number) =>
  Date.UTC(Math.floor(n / 10000), (Math.floor(n / 100) % 100) - 1, n % 100) / 1000 - OFFSET;
export const monthStart = (e: number) => {
  const d = new Date((e + OFFSET) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000 - OFFSET;
};
export const addMonths = (e: number, n: number) => {
  const d = new Date((e + OFFSET) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1) / 1000 - OFFSET;
};
export const yearStart = (e: number) => {
  const d = new Date((e + OFFSET) * 1000);
  return Date.UTC(d.getUTCFullYear(), 0, 1) / 1000 - OFFSET;
};
// Monday-based week start
export const weekStart = (e: number) => {
  const s = dayStart(e);
  const dow = (new Date((s + OFFSET) * 1000).getUTCDay() + 6) % 7;
  return s - dow * DAY;
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function f(opts: Intl.DateTimeFormatOptions) {
  const k = JSON.stringify(opts);
  let x = fmtCache.get(k);
  if (!x) fmtCache.set(k, (x = new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...opts })));
  return x;
}
export const fmtTime = (e: number) => f({ hour: "numeric", minute: "2-digit" }).format(e * 1000);
export const fmtTimeS = (e: number) => f({ hour: "numeric", minute: "2-digit", second: "2-digit" }).format(e * 1000);
export const fmtDate = (e: number) => f({ day: "numeric", month: "short", year: "numeric" }).format(e * 1000);
export const fmtDay = (e: number) => f({ weekday: "short", day: "numeric", month: "short" }).format(e * 1000);
export const fmtDateTime = (e: number) =>
  f({ day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(e * 1000);
export const fmtMonth = (e: number) => f({ month: "long", year: "numeric" }).format(e * 1000);
export const fmtYmd = (n: number) => fmtDate(ymdToEpoch(n) + 43200);
export const minToTime = (m: number) => (m >= 0 && m < 1440 ? fmtTime(dayStart(nowS()) + m * 60) : "—");

export function ago(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec < 5) return "just now";
  if (sec < 60) return `${Math.round(sec)} seconds ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}
export function dur(sec: number): string {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
