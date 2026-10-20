import { render } from "preact";
import { useEffect, useErrorBoundary, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import "./styles.css";
import { api, setDemo } from "./api";
import { statusOf } from "./format";
import { Diagnostics } from "./pages/diagnostics";
import { Energy } from "./pages/energy";
import { Explorer } from "./pages/explorer";
import { LivePage } from "./pages/live";
import { Measurements } from "./pages/measurements";
import { Mppt } from "./pages/mppt";
import { Overview } from "./pages/overview";
import { SettingsPage } from "./pages/settings";
import { freshness, loadPref, sampleAge, savePref, start, useStore, val } from "./state";
import { TZ, ago } from "./time";
import { Icon } from "./ui";
import { go, type PageId } from "./nav";

const PAGES = [
  ["overview", "Overview", "overview"],
  ["live", "Live monitoring", "live"],
  ["explorer", "Graph explorer", "explorer"],
  ["mppt", "MPPT performance", "mppt"],
  ["energy", "Energy history", "energy"],
  ["all", "All measurements", "all"],
  ["diagnostics", "Inverter diagnostics", "diag"],
  ["settings", "Settings", "settings"],
] as const;

function route(): { page: PageId; q: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, "");
  const [p, qs] = h.split("?");
  const page = (PAGES.find((x) => x[0] === p)?.[0] ?? "overview") as PageId;
  return { page, q: new URLSearchParams(qs || "") };
}
function Clock() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, []);
  return (
    <span class="muted small num hide-sm">
      {new Intl.DateTimeFormat("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date())}
    </span>
  );
}

function StatusChip() {
  const s = useStore();
  const f = freshness();
  const st = statusOf(val("status"), f !== "offline");
  const tone = f === "offline" ? "" : f === "stale" ? "warn" : st.tone;
  const label = f === "loading" ? "Connecting" : f === "offline" ? "Offline" : f === "stale" ? "Stale data" : st.label;
  return (
    <div class="row" title={s.liveErr || ""}>
      <span class={`chip ${tone}`}><span class={`dot ${tone}`} />{label}</span>
      {f !== "loading" && <span class="muted small num hide-sm">{isFinite(sampleAge()) ? ago(sampleAge()) : "no reading yet"}</span>}
    </div>
  );
}

function Boundary(p: { children: ComponentChildren; k: string }) {
  const [err, reset] = useErrorBoundary();
  useEffect(() => { if (err) reset(); }, [p.k]);
  if (err) return (
    <div class="banner err">
      <span class="grow">This page hit an error: {String((err as Error).message || err)}</span>
      <button class="btn sm" onClick={reset}>Try again</button>
    </div>
  );
  return <>{p.children}</>;
}

function App() {
  const [r, setR] = useState(route());
  const [collapsed, setCollapsed] = useState(loadPref("navCollapsed", false));
  const [open, setOpen] = useState(false);
  const s = useStore();
  useEffect(() => {
    start();
    const f = () => { setR(route()); setOpen(false); scrollTo(0, 0); };
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  const title = PAGES.find((p) => p[0] === r.page)![1];
  const Page = {
    overview: Overview, live: LivePage, explorer: Explorer, mppt: Mppt, energy: Energy,
    all: Measurements, diagnostics: Diagnostics, settings: SettingsPage,
  }[r.page];

  return (
    <div class="shell">
      <div class={`scrim ${open ? "open" : ""}`} onClick={() => setOpen(false)} />
      <nav class={`side ${collapsed ? "collapsed" : ""} ${open ? "open" : ""}`} aria-label="Main">
        <div class="brand">
          <div class="logo"><Icon n="logo" size={20} /></div>
          <div class="lbl">
            <h1>Solar Analytics</h1>
            <p>{s.meta ? "MIN 8000TL-X" : "Loading…"}</p>
          </div>
        </div>
        {PAGES.map(([id, label, icon]) => (
          <button class={`nav ${r.page === id ? "on" : ""}`} onClick={() => go(id)} title={label} key={id}>
            <Icon n={icon} /><span class="lbl">{label}</span>
          </button>
        ))}
        <div class="spacer" />
        <button class="nav collapse-btn" onClick={() => { setCollapsed(!collapsed); savePref("navCollapsed", !collapsed); }} title="Collapse sidebar">
          <Icon n="collapse" class={collapsed ? "chev open" : ""} /><span class="lbl">Collapse</span>
        </button>
      </nav>
      <div class="main">
        <header class="top">
          <button class="btn ghost icon menu-btn" onClick={() => setOpen(true)} aria-label="Menu"><Icon n="menu" /></button>
          <h2 class="grow">{title}</h2>
          {api.demo && <span class="chip demo">DEMO</span>}
          <Clock />
          <StatusChip />
        </header>
        <main class="content">
          {api.demo && (
            <div class="banner demo">
              <b>DEMO MODE</b><span class="grow">All values on every page are synthetic and do not come from your inverter.</span>
              <button class="btn sm" onClick={() => setDemo(false)}>Exit demo</button>
            </div>
          )}
          {s.metaErr && !s.meta && (
            <div class="banner err">
              <span class="grow">Cannot reach the dongle: {s.metaErr}</span>
              <button class="btn sm" onClick={() => location.reload()}>Retry</button>
              <button class="btn sm" onClick={() => setDemo(true)}>Preview demo</button>
            </div>
          )}
          {s.meta ? <Boundary k={r.page}><Page q={r.q} /></Boundary> : !s.metaErr && <div class="empty" style={{ minHeight: 300 }}>Loading catalogue…</div>}
        </main>
      </div>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
