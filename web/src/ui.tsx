import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Quality } from "./api";
import { fmtValue } from "./format";

const ICONS: Record<string, string> = {
  logo: "M3 20h18M5 16l4-5 4 3 6-8",
  overview: "M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z",
  live: "M3 12h4l3-8 4 16 3-8h4",
  explorer: "M3 3v18h18M7 15l4-4 3 3 6-6",
  mppt: "M12 3v3M5.6 5.6l2.1 2.1M3 12h3M18 12h3M16.3 7.7l2.1-2.1M8 12a4 4 0 0 1 8 0M4 21h16M7 17h10",
  energy: "M5 21V10M10 21V4M15 21v-7M20 21v-11",
  all: "M4 5h16M4 10h16M4 15h10M4 20h7",
  diag: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  menu: "M4 6h16M4 12h16M4 18h16",
  collapse: "M15 18l-6-6 6-6",
  chev: "M9 18l6-6-6-6",
  check: "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3",
  plus: "M12 5v14M5 12h14",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  info: "M12 16v-4M12 8h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z",
  x: "M18 6 6 18M6 6l12 12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  save: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2",
  pin: "M12 17v5M5 17h14l-1.8-2.7a2 2 0 0 1-.3-1.1V6a1 1 0 0 1 1-1H6a1 1 0 0 1 1 1v7.2a2 2 0 0 1-.3 1.1z",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  reset: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
  wifi: "M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01",
};

export function Icon(p: { n: string; size?: number; class?: string }) {
  return (
    <svg width={p.size ?? 18} height={p.size ?? 18} viewBox="0 0 24 24" fill={p.n === "star-on" ? "currentColor" : "none"} stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class={p.class} aria-hidden="true">
      <path d={ICONS[p.n === "star-on" ? "star" : p.n] || ""} />
    </svg>
  );
}

export function Card(p: { title?: ComponentChildren; sub?: ComponentChildren; right?: ComponentChildren; children?: ComponentChildren; class?: string; id?: string }) {
  return (
    <section class={`card ${p.class ?? ""}`} id={p.id}>
      {(p.title || p.right) && (
        <div class="card-head">
          <div>
            {p.title && <h3>{p.title}</h3>}
            {p.sub && <p class="sub">{p.sub}</p>}
          </div>
          {p.right}
        </div>
      )}
      {p.children}
    </section>
  );
}

export function Stat(p: {
  label: string; value: number | null | undefined; unit: string; foot?: ComponentChildren; tone?: string;
  onClick?: () => void; sm?: boolean; corner?: ComponentChildren; text?: string;
}) {
  const f = fmtValue(p.value, p.unit);
  return (
    <div class={`stat${p.onClick ? " click" : ""}${p.sm ? " sm" : ""}`} onClick={p.onClick} role={p.onClick ? "button" : undefined}>
      <div class="k"><span>{p.label}</span>{p.corner}</div>
      <div class="v num">
        {p.text ? p.text : p.value == null ? <span class="na">Unavailable</span> : <>{f.v}<span class="u">{f.u}</span></>}
      </div>
      {p.foot && <div class="foot">{p.tone !== undefined && <span class={`dot ${p.tone}`} />}{p.foot}</div>}
    </div>
  );
}

export const QUALITY_LABEL: Record<Quality, string> = {
  verified: "Verified",
  documented: "Documented",
  unverified: "Unverified",
};
export function QualityBadge(p: { q: Quality }) {
  const tone = p.q === "verified" ? "ok" : p.q === "documented" ? "acc" : "warn";
  return <span class={`chip ${tone}`} title={QUALITY_HELP[p.q]}>{QUALITY_LABEL[p.q]}</span>;
}
export const QUALITY_HELP: Record<Quality, string> = {
  verified: "Cross-checked against real data from your inverter.",
  documented: "Documented Growatt register with plausible values; not independently cross-checked.",
  unverified: "Meaning or consistency not yet established - treat with caution.",
};

export function Seg<T extends string>(p: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div class="seg">
      {p.options.map(([v, l]) => (
        <button key={v} class={v === p.value ? "on" : ""} onClick={() => p.onChange(v)}>{l}</button>
      ))}
    </div>
  );
}

export function Empty(p: { children: ComponentChildren; h?: number }) {
  return <div class="empty" style={{ minHeight: p.h ?? 160 }}>{p.children}</div>;
}

export function Modal(p: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && p.onClose()}>
      <div class="modal" role="dialog" aria-label={p.title}>
        <div class="row between" style={{ marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{p.title}</h3>
          <button class="btn ghost icon" onClick={p.onClose} aria-label="Close"><Icon n="x" /></button>
        </div>
        {p.children}
      </div>
    </div>
  );
}

/** Loads async data; re-runs when deps change and optionally every `everyMs`. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], everyMs = 0) {
  const [s, set] = useState<{ data?: T; err?: string; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  useEffect(() => {
    let timer = 0;
    const run = async () => {
      const my = ++seq.current;
      try {
        const data = await fn();
        if (my === seq.current) set({ data, loading: false });
      } catch (e) {
        if (my === seq.current) set((p) => ({ data: p.data, err: String((e as Error).message || e), loading: false }));
      }
      if (everyMs) timer = window.setTimeout(run, everyMs);
    };
    set((p) => ({ ...p, loading: true }));
    run();
    return () => {
      seq.current++;
      clearTimeout(timer);
    };
  }, deps);
  return s;
}

export function download(name: string, data: BlobPart, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
