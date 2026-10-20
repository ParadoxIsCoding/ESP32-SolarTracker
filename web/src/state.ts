// Tiny global store: catalogue, live polling and an in-browser rolling
// buffer of live samples (the finest-resolution data; not stored on device).
import { useEffect, useState } from "preact/hooks";
import { api, type Chan, type Health, type Live, type Meta } from "./api";
import { nowS } from "./time";

export interface State {
  meta?: Meta;
  metaErr?: string;
  live?: Live;
  liveErr?: string;
  lastFetchOk: number; // epoch s of last successful /api/live
  health?: Health;
  buf: { t: number[]; v: (number | null)[][] };
  tick: number;
}
const BUF_SECONDS = 30 * 60;

const state: State = { lastFetchOk: 0, buf: { t: [], v: [] }, tick: 0 };
const subs = new Set<() => void>();
const emit = () => {
  state.tick++;
  subs.forEach((f) => f());
};

export function useStore(): State {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return state;
}
export const getState = () => state;

export function chanIndex(id: string): number {
  return state.meta ? state.meta.channels.findIndex((c) => c.id === id) : -1;
}
export function chan(id: string): Chan | undefined {
  return state.meta?.channels.find((c) => c.id === id);
}

/** Live data freshness. "offline" = no link or no reply; "stale" = old. */
export function freshness(): "live" | "stale" | "offline" | "loading" {
  const l = state.live;
  if (!l) return state.liveErr ? "offline" : "loading";
  if (!l.link || l.ageMs < 0) return "offline";
  if (nowS() - state.lastFetchOk > 20) return "offline";
  if (l.ageMs > Math.max(3 * l.fastMs, 10000)) return "stale";
  return "live";
}

/** Current value of a channel, or null when unknown/offline. */
export function val(id: string): number | null {
  const i = chanIndex(id);
  const l = state.live;
  if (i < 0 || !l || freshness() === "offline") return null;
  return l.v[i] ?? null;
}

export function sampleAge(): number {
  const l = state.live;
  if (!l || l.ageMs < 0) return Infinity;
  return l.ageMs / 1000 + (nowS() - state.lastFetchOk);
}

function pushBuffer(l: Live) {
  const b = state.buf;
  if (!l.link || l.ageMs < 0 || !l.t) return;
  if (b.t.length && b.t[b.t.length - 1] >= l.t) return;
  if (!b.v.length) b.v = l.v.map(() => []);
  b.t.push(l.t);
  l.v.forEach((x, i) => b.v[i].push(x));
  const cut = l.t - BUF_SECONDS;
  let k = 0;
  while (k < b.t.length && b.t[k] < cut) k++;
  if (k) {
    b.t.splice(0, k);
    b.v.forEach((a) => a.splice(0, k));
  }
}

let started = false;
export function start() {
  if (started) return;
  started = true;
  api.meta().then(
    (m) => { state.meta = m; emit(); },
    (e) => { state.metaErr = String(e.message || e); emit(); },
  );
  const pollLive = async () => {
    try {
      const l = await api.live();
      state.live = l;
      state.liveErr = undefined;
      state.lastFetchOk = nowS();
      pushBuffer(l);
    } catch (e) {
      state.liveErr = String((e as Error).message || e);
    }
    emit();
    const fast = state.live?.fastMs || 2000;
    setTimeout(pollLive, document.hidden ? 15000 : Math.max(1000, fast));
  };
  pollLive();
  const pollHealth = async () => {
    try { state.health = await api.health(); emit(); } catch {}
    setTimeout(pollHealth, 30000);
  };
  pollHealth();
  // re-render relative times ("5 seconds ago")
  setInterval(emit, 5000);
  document.addEventListener("visibilitychange", () => !document.hidden && emit());
}

// ------------------------------------------------------- local prefs ---
export function loadPref<T>(key: string, def: T): T {
  try {
    const s = localStorage.getItem("solar." + key);
    return s == null ? def : (JSON.parse(s) as T);
  } catch {
    return def;
  }
}
export function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem("solar." + key, JSON.stringify(v));
  } catch {}
}
