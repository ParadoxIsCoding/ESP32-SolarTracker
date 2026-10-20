// Synthetic DEMO data. Used only when demo mode is switched on; the UI shows
// a permanent "DEMO - synthetic data" banner whenever this provider is active.
import type { Api, Day, Meta, Series } from "./api";
import { tierCols } from "./proto";
import metaJson from "./catalog.gen.json";
import { DAY, OFFSET, dayStart, nowS, ymd, ymdToEpoch } from "./time";

const meta = metaJson as unknown as Meta;
const idx = new Map(meta.channels.map((c, i) => [c.id, i]));

function hash(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
function smoothNoise(x: number, seed: number) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i + seed) * (1 - u) + hash(i + 1 + seed) * u;
}
const dayNum = (e: number) => Math.floor((e + OFFSET) / DAY);

function sun(e: number) {
  const m = ((e + OFFSET) % DAY) / 60;
  const rise = 330, set = 1112;
  if (m <= rise || m >= set) return 0;
  return Math.pow(Math.sin((Math.PI * (m - rise)) / (set - rise)), 1.25);
}
function power(e: number) {
  const d = dayNum(e);
  const dayF = 0.62 + 0.38 * hash(d * 7.1);
  const cloud = 1 - 0.45 * Math.pow(smoothNoise(e / 900, d), 3) * (1 - dayF + 0.35);
  return Math.min(8150, 8300 * sun(e) * dayF * cloud);
}

const cumCache = new Map<number, number[]>();
function energyToday(e: number, share = 1): number {
  const d = dayNum(e);
  let arr = cumCache.get(d);
  if (!arr) {
    arr = [0];
    const s = dayStart(e);
    for (let i = 1; i <= 288; i++) arr.push(arr[i - 1] + (power(s + i * 300) * 300) / 3.6e6);
    cumCache.set(d, arr);
  }
  const i = Math.floor((e - dayStart(e)) / 300);
  return arr[Math.max(0, Math.min(288, i))] * share;
}

function values(e: number): Record<string, number> {
  const ppv = power(e);
  const on = ppv > 15;
  const pac = on ? ppv * 0.962 : 0;
  const load = 380 + 260 * smoothNoise(e / 600, 3) + (hash(Math.floor(e / 1800)) > 0.85 ? 1800 : 0);
  const vac = 239.5 + 2.4 * Math.sin(e / 3000) + (pac / 8000) * 2.2;
  const s = sun(e);
  const days = dayNum(e) - 19800;
  return {
    status: on ? 1 : 0, runstate: 0, pac, ppv, opct: Math.round((pac / 8000) * 100),
    vpv1: on ? 268 + 38 * s : 0, ipv1: on ? (ppv * 0.61) / (268 + 38 * s) : 0, ppv1: ppv * 0.61,
    vpv2: on ? 262 + 35 * s : 0, ipv2: on ? (ppv * 0.39) / (262 + 35 * s) : 0, ppv2: ppv * 0.39,
    vpv3: 7.2, ipv3: 0, ppv3: 0,
    vac, iac: pac / vac, fac: 50 + 0.04 * Math.sin(e / 700), sac: pac * 1.001, qac: 0, pfraw: 20000,
    eac_today: energyToday(e, 0.962), eac_total: 57540 + days * 38 + energyToday(e, 0.962),
    epv_today: energyToday(e), epv_total: 61368 + days * 39.5 + energyToday(e),
    epv1_today: energyToday(e, 0.61), epv1_total: 27095 + days * 24, epv2_today: energyToday(e, 0.39),
    epv2_total: 34273 + days * 15.4, epv3_today: 0, epv3_total: 0, worktime: 18443 + days * 12.6,
    tinv: 24 + 21 * (pac / 8000) + 3 * s, tipm: 25 + 23 * (pac / 8000), tboost: 0, tcomm: 27 + 9 * s,
    pbus: on ? 368 + 10 * s : 0, iso: 1324, dci: 0, gfci: 0, derate: 14, fault: 0, warn: 0, pmaxlim: 0, startdelay: 65,
    pimp: Math.max(0, load - pac), pexp: Math.max(0, pac - load), pload: load,
    eimp_today: 0.4, eexp_today: energyToday(e, 0.7), eload_today: energyToday(e, 0.33),
    eimp_total: 6601, eexp_total: 39991 + days * 25, eload_total: 27978 + days * 11,
  };
}

const delay = <T>(x: T) => new Promise<T>((r) => setTimeout(() => r(x), 60));

function series(tier: 1 | 15, from: number, to: number, codes: number[]): Series {
  const step = tier === 1 ? 60 : 900;
  const cols = tierCols(meta, tier);
  const want = codes.map((c) => cols.find((x) => x.code === c)!);
  const t: number[] = [];
  const out: (number | null)[][] = want.map(() => []);
  const end = Math.min(to, nowS());
  for (let e = Math.ceil(from / step) * step; e <= end; e += step) {
    if (sun(e) <= 0.002) continue; // inverter (and stick) are off at night
    const v = values(e);
    let vmax = v;
    if (tier === 15) for (let k = 60; k < 900; k += 60) { const w = values(e + k); if (w.pac > vmax.pac) vmax = w; }
    t.push(e);
    want.forEach((c, i) => {
      const x = (c.agg === "max" ? vmax : v)[c.id];
      out[i].push(x == null ? null : Math.round(x / c.scale));
    });
  }
  return { t, cols: out };
}

function days(a: number, b: number): Day[] {
  const res: Day[] = [];
  const first = Math.max(ymdToEpoch(a), dayStart(nowS()) - 90 * DAY);
  for (let s = first; s <= Math.min(ymdToEpoch(b), nowS()); s += DAY) {
    const end = Math.min(s + DAY - 1, nowS());
    let peak = 0, peakMin = 0, p1 = 0, p2 = 0, tmax = 0, first = -1, last = -1;
    for (let e = s; e <= end; e += 300) {
      const v = values(e);
      if (v.pac > peak) { peak = v.pac; peakMin = (e - s) / 60; }
      p1 = Math.max(p1, v.ppv1); p2 = Math.max(p2, v.ppv2); tmax = Math.max(tmax, v.tinv);
      if (v.pac > 0) { if (first < 0) first = (e - s) / 60; last = (e - s) / 60; }
    }
    const v = values(end);
    res.push({
      date: ymd(s), eac: Math.round(v.eac_today * 10), epv1: Math.round(v.epv1_today * 10), epv2: Math.round(v.epv2_today * 10), epv3: 0,
      eacTotalFirst: Math.round((v.eac_total - v.eac_today) * 10), eacTotalLast: Math.round(v.eac_total * 10),
      eimp: 4, eexp: Math.round(v.eexp_today * 10), eload: Math.round(v.eload_today * 10),
      pacPeak: Math.round(peak), pacPeakMin: peakMin, ppv1Peak: Math.round(p1), ppv2Peak: Math.round(p2), ppv3Peak: 1,
      tinvMax: Math.round(tmax * 10), vacMin: 2371, vacMax: 2452, facMin: 4996, facMax: 5004,
      firstGenMin: first, lastGenMin: last, onlineMin: Math.max(0, last - first + 20), genMin: Math.max(0, last - first),
      fault: 0, warn: 0, flags: 0, partial: end < s + DAY - 1 ? 1 : 0,
    });
  }
  return res;
}

export const demoApi: Api = {
  demo: true,
  meta: () => delay(meta),
  live() {
    const e = Math.floor(nowS());
    const v = values(e);
    return delay({ t: e, now: e, ageMs: 400, slowAgeMs: 4000, link: true, fastMs: 2000, time: "ntp" as const,
      v: meta.channels.map((c) => (v[c.id] == null ? null : +v[c.id].toFixed(3))) });
  },
  series: (tier, from, to, codes) => delay(series(tier, from, to, codes)),
  days: (a, b) => delay(days(a, b)),
  device: () => delay({ name: "Demo inverter", valid: true, serial: "DEMO000000", model: "PV Inverter", fw: "AM1.0", controlFw: "ZABA",
    fwBuild: "AMAA02010008", dtc: 5201, trackers: 2, phases: 1, modbusVersion: 305, comAddress: 1, activePowerRate: 100,
    inverterClock: "synthetic", clockDriftS: 0, protection: [1800, 2650, 4700, 5200, 700, 2750, 4700, 5200, 700, 2750, 4700, 5200],
    protocol: "DEMO - synthetic data", readOnly: true }),
  health: () => delay({ fw: "demo", readOnly: true, stick: 2, uptimeS: 18000, resetReason: "demo", epoch: Math.floor(nowS()), timeSource: "ntp",
    mem: { freeHeap: 23000, maxBlock: 18000, fragPct: 9, sketch: 560000, freeSketch: 1500000 },
    wifi: { rssi: -58, ip: "demo", mac: "00:00:00:00:00:00", channel: 11 },
    modbus: { link: true, ok: 9000, fail: 3, consecutiveFail: 0, lastOkAgeS: 0, lastPollMs: 62, maxPollMs: 260, fastMs: 2000, currentFastMs: 2000, slowMs: 10000 },
    storage: { total: 2072576, used: 640000, h1Bytes: 420000, h1Files: 10, h1Budget: 1114112, h15Bytes: 36000, h15Files: 2, h15Budget: 458752, dayBytes: 1200, dayFiles: 1, dayBudget: 180224, oldestH1Day: ymd(nowS() - 9 * DAY), pendingMinutes: 2 } }),
  events: () => delay([[Math.floor(nowS()) - 30000, 1, 6, 0], [Math.floor(nowS()) - 29990, 2, 0, 0], [Math.floor(nowS()) - 29980, 3, 0, 0]]),
  registers: () => delay({ inputBase: 3000, inputAgeMs: 400, input: Array(125).fill(0), holdingAgeMs: 4000, holding: Array(125).fill(0) }),
  files: () => delay([]),
  settings: () => delay({ name: "Demo inverter", fastMs: 2000, slowMs: 10000, tariffImport: 0.27974, tariffExport: 0.08, tariffExport2: 0.03, exportTier1Kwh: 8, supplyPerDay: 1.92015, co2PerKwh: 0.73 }),
  saveSettings: async () => { throw new Error("Settings cannot be saved in demo mode."); },
};
