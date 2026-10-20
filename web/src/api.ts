// Data access for the dashboard. Two providers implement the same interface:
// the real stick (/api/*) and a clearly-labelled synthetic demo provider.
import { demoApi } from "./demo";
import { decodeDays, decodeSeries } from "./proto";
export * from "./proto";

export type Quality = "verified" | "documented" | "unverified";
export interface Chan {
  id: string;
  name: string;
  unit: string;
  cat: string;
  reg: number;
  type: string;
  scale: number;
  kind: "status" | "code" | "power" | "instant" | "counter_day" | "counter_total";
  quality: Quality;
  desc: string;
  mppt?: number;
}
export interface Meta {
  categories: { id: string; name: string }[];
  channels: Chan[];
  tiers: {
    h1: { interval: number; channels: string[]; scale: number[] };
    h15: { interval: number; channels: string[]; scale: number[] };
  };
}
export interface Live {
  t: number; // epoch of last successful fast poll
  now: number; // device clock
  ageMs: number; // -1 = never
  slowAgeMs: number;
  link: boolean;
  fastMs: number;
  time: "ntp" | "inverter" | "none";
  v: (number | null)[];
}
export interface Series {
  t: number[]; // epoch seconds
  cols: (number | null)[][];
}
export interface Day {
  date: number; eac: number; epv1: number; epv2: number; epv3: number;
  eacTotalFirst: number; eacTotalLast: number; eimp: number; eexp: number; eload: number;
  pacPeak: number; pacPeakMin: number; ppv1Peak: number; ppv2Peak: number; ppv3Peak: number;
  tinvMax: number; vacMin: number; vacMax: number; facMin: number; facMax: number;
  firstGenMin: number; lastGenMin: number; onlineMin: number; genMin: number;
  fault: number; warn: number; flags: number; partial: number;
}
export interface Device {
  name: string; valid: boolean; serial?: string; model?: string; fw?: string; controlFw?: string;
  fwBuild?: string; dtc?: number; trackers?: number; phases?: number; modbusVersion?: number;
  comAddress?: number; activePowerRate?: number; inverterClock?: string; clockDriftS?: number;
  protection?: number[]; protocol: string; readOnly: boolean;
}
export interface Health {
  fw: string; readOnly: boolean; stick: number; uptimeS: number; resetReason: string;
  epoch: number; timeSource: string;
  mem: { freeHeap: number; maxBlock: number; fragPct: number; sketch: number; freeSketch: number };
  wifi: { rssi: number; ip: string; mac: string; channel: number };
  modbus: { link: boolean; ok: number; fail: number; consecutiveFail: number; lastOkAgeS: number;
    lastPollMs: number; maxPollMs: number; fastMs: number; currentFastMs: number; slowMs: number };
  storage: { total: number; used: number; h1Bytes: number; h1Files: number; h1Budget: number;
    h15Bytes: number; h15Files: number; h15Budget: number; dayBytes: number; dayFiles: number;
    dayBudget: number; oldestH1Day: number; pendingMinutes: number };
}
export interface Settings {
  name: string; fastMs: number; slowMs: number; tariffImport: number; tariffExport: number; tariffExport2: number;
  exportTier1Kwh: number; supplyPerDay: number; co2PerKwh: number;
}
export type EventRow = [number, number, number, number];
export interface Registers { inputBase: number; inputAgeMs: number; input: number[]; holdingAgeMs: number; holding: number[] }

export interface Api {
  demo: boolean;
  meta(): Promise<Meta>;
  live(): Promise<Live>;
  series(tier: 1 | 15, from: number, to: number, codes: number[]): Promise<Series>;
  days(fromYmd: number, toYmd: number): Promise<Day[]>;
  device(): Promise<Device>;
  health(): Promise<Health>;
  events(): Promise<EventRow[]>;
  registers(): Promise<Registers>;
  files(): Promise<{ path: string; size: number }[]>;
  settings(): Promise<Settings>;
  saveSettings(s: Partial<Settings>): Promise<Settings>;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export const realApi: Api = {
  demo: false,
  meta: () => getJson("/api/meta"),
  live: () => getJson("/api/live"),
  async series(tier, from, to, codes) {
    const r = await fetch(`/api/series?tier=${tier}&from=${Math.floor(from)}&to=${Math.floor(to)}&cols=${codes.join(",")}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`series: HTTP ${r.status}`);
    return decodeSeries(await r.arrayBuffer());
  },
  async days(a, b) {
    return decodeDays(await getJson(`/api/days?from=${a}&to=${b}`));
  },
  device: () => getJson("/api/device"),
  health: () => getJson("/api/health"),
  events: () => getJson("/api/events"),
  registers: () => getJson("/api/registers"),
  files: () => getJson("/api/files"),
  settings: () => getJson("/api/settings"),
  async saveSettings(s) {
    const r = await fetch("/api/settings", { method: "POST", body: JSON.stringify(s), headers: { "content-type": "application/json" } });
    if (r.status === 401) throw new Error("Authentication required - use the firmware update credentials.");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  },
};

const DEMO_KEY = "solar.demo";
export function demoRequested(): boolean {
  if (/[?&]demo\b/.test(location.search) || location.hash.includes("demo")) return true;
  try {
    return localStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}
export function setDemo(on: boolean) {
  try {
    on ? localStorage.setItem(DEMO_KEY, "1") : localStorage.removeItem(DEMO_KEY);
  } catch {}
  location.reload();
}

export const api: Api = demoRequested() ? demoApi : realApi;

