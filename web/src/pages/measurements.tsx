import { useState } from "preact/hooks";
import type { Chan } from "../api";
import { Spark } from "../chart";
import { storedIds } from "../data";
import { fmtValue } from "../format";
import { openInExplorer } from "../nav";
import { chanIndex, freshness, loadPref, sampleAge, savePref, useStore } from "../state";
import { ago, dur } from "../time";
import { Card, Icon, Modal, QualityBadge, QUALITY_HELP, Seg } from "../ui";

const CAT_COLOR: Record<string, string> = { solar: "#55c7f7", mppt: "#a78bfa", ac: "#34d399", energy: "#fbbf24", diag: "#f87171", meter: "#94a3b8" };
const PV_COLOR: Record<number, string> = { 1: "#55c7f7", 2: "#a78bfa", 3: "#fbbf24" };

function unavailableReason(ch: Chan, v: number | null, online: boolean): string | null {
  if (!online) return "No connection to the inverter right now (it may be off for the night).";
  if (v == null) return "No value received yet.";
  if (ch.id === "tboost" && v === 0) return "Reads 0 on this inverter - probably not implemented by the MIN TL-X.";
  return null;
}

export function Measurements() {
  const s = useStore();
  const meta = s.meta!;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"cat" | "az">(loadPref("mSort", "cat"));
  const [dense, setDense] = useState<"detail" | "compact">(loadPref("mDense", "detail"));
  const [favs, setFavs] = useState<string[]>(loadPref("favs", ["pac", "eac_today", "ppv1", "ppv2", "tinv"]));
  const [closed, setClosed] = useState<string[]>(loadPref("mClosed", []));
  const [onlySupported, setOnlySupported] = useState(loadPref("mSupported", false));
  const [info, setInfo] = useState<Chan | null>(null);
  const f = freshness();
  const online = f === "live" || f === "stale";
  const stored = storedIds(meta);
  const age = sampleAge();

  const setF = (v: string[]) => { setFavs(v); savePref("favs", v); };
  const toggleCat = (id: string) => { const v = closed.includes(id) ? closed.filter((x) => x !== id) : [...closed, id]; setClosed(v); savePref("mClosed", v); };
  const value = (ch: Chan) => (online ? s.live?.v[chanIndex(ch.id)] ?? null : null);
  const match = (ch: Chan) => !q || `${ch.name} ${ch.id} ${ch.unit} ${ch.cat}`.toLowerCase().includes(q.toLowerCase());
  const supported = (ch: Chan) => !(ch.id === "tboost" && value(ch) === 0);

  const cardFor = (ch: Chan, i?: number) => {
    const v = value(ch);
    const fv = ch.kind === "code" || ch.kind === "status" ? { v: v == null ? "—" : String(v), u: "" } : fmtValue(v, ch.unit);
    const isFav = favs.includes(ch.id);
    const spark = s.buf.v[chanIndex(ch.id)];
    const color = ch.mppt ? PV_COLOR[ch.mppt] : CAT_COLOR[ch.cat];
    return (
      <div class={`mcard ${dense === "compact" ? "compact click" : ""}`} key={ch.id} onClick={dense === "compact" ? () => setInfo(ch) : undefined}>
        <div class="top2">
          <span class="nm" title={ch.desc}>{ch.name}</span>
          {ch.mppt ? <span class="dot" style={{ background: PV_COLOR[ch.mppt] }} /> : null}
        </div>
        <div class="val num" style={v == null ? { color: "var(--faint)", fontSize: 16 } : {}}>{v == null ? "Unavailable" : <>{fv.v}{fv.u && <span class="u">{fv.u}</span>}</>}</div>
        {dense === "detail" && <Spark v={spark ?? []} color={color} />}
        {dense === "detail" && (
          <div class="meta">
            <span class={`q-${ch.quality}`} title={`${QUALITY_HELP[ch.quality]} ${stored.has(ch.id) ? "Logged every minute." : "Live only."}`}>● {ch.quality}</span>
          <span class="acts">
            {i != null && <>
              <button onClick={() => i > 0 && setF(favs.map((x, k) => (k === i - 1 ? ch.id : k === i ? favs[i - 1] : x)))} title="Move left" aria-label="Move left"><Icon n="left" size={13} /></button>
              <button onClick={() => i < favs.length - 1 && setF(favs.map((x, k) => (k === i + 1 ? ch.id : k === i ? favs[i + 1] : x)))} title="Move right" aria-label="Move right"><Icon n="right" size={13} /></button>
            </>}
            <button class={isFav ? "fav" : ""} onClick={() => setF(isFav ? favs.filter((x) => x !== ch.id) : [...favs, ch.id])} title={isFav ? "Remove favourite" : "Add to favourites"} aria-label="Favourite"><Icon n={isFav ? "star-on" : "star"} size={13} /></button>
            <button onClick={() => openInExplorer([ch.id], stored.has(ch.id) ? "today" : "live")} title="Chart in Graph Explorer" aria-label="Chart"><Icon n="plus" size={13} /></button>
            <button onClick={() => setInfo(ch)} title="Details" aria-label="Details"><Icon n="info" size={13} /></button>
          </span>
          </div>
        )}
      </div>
    );
  };

  let list = meta.channels.filter(match).filter((ch) => !onlySupported || ch.quality !== "unverified");
  if (sort === "az") list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
  const avail = list.filter((ch) => supported(ch));
  const unavailable = list.filter((ch) => !supported(ch));
  const favList = favs.map((id) => meta.channels.find((c) => c.id === id)).filter((c): c is Chan => !!c && match(c));
  const h = s.health;

  const groups = sort === "az"
    ? [{ id: "az", name: "All measurements A–Z", chans: avail }]
    : meta.categories.map((c) => ({ ...c, chans: avail.filter((ch) => ch.cat === c.id) })).filter((g) => g.chans.length);

  return (
    <>
      <div class="row wrap between" style={{ gap: 10 }}>
        <input class="input grow" style={{ maxWidth: 360 }} placeholder={`Search ${meta.channels.length} measurements`} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <div class="row wrap" style={{ gap: 8 }}>
          <label class="row small muted" style={{ cursor: "pointer" }}><input type="checkbox" checked={onlySupported} onChange={() => { setOnlySupported(!onlySupported); savePref("mSupported", !onlySupported); }} />Hide unverified</label>
          <Seg value={sort} options={[["cat", "By category"], ["az", "A–Z"]]} onChange={(v) => { setSort(v); savePref("mSort", v); }} />
          <Seg value={dense} options={[["detail", "Detailed"], ["compact", "Compact"]]} onChange={(v) => { setDense(v); savePref("mDense", v); }} />
        </div>
      </div>
      <div class="row small muted">
        <span class={`dot ${f === "live" ? "ok" : f === "stale" ? "warn" : ""}`} />
        {f === "live" ? `Live · updated ${ago(age)}` : f === "stale" ? `Stale · last reading ${ago(age)}` : "Offline — showing nothing rather than old values"}
      </div>

      {favList.length > 0 && (
        <section>
          <div class="cat-h" onClick={() => toggleCat("fav")}>
            <Icon n="chev" class={`chev ${closed.includes("fav") ? "" : "open"}`} size={16} /><h3>Favourites</h3><span class="cnt">{favList.length}</span>
          </div>
          {!closed.includes("fav") && <div class="grid auto-sm" style={{ marginTop: 10 }}>{favList.map((ch, i) => cardFor(ch, i))}</div>}
        </section>
      )}

      {groups.map((g) => (
        <section key={g.id}>
          <div class="cat-h" onClick={() => toggleCat(g.id)}>
            <Icon n="chev" class={`chev ${closed.includes(g.id) ? "" : "open"}`} size={16} />
            <span class="dot" style={{ background: CAT_COLOR[g.id] ?? "var(--muted)" }} />
            <h3>{g.name}</h3><span class="cnt">{g.chans.length}</span>
          </div>
          {!closed.includes(g.id) && <div class="grid auto-sm" style={{ marginTop: 10 }}>{g.chans.map((ch) => cardFor(ch))}</div>}
        </section>
      ))}

      <section>
        <div class="cat-h" onClick={() => toggleCat("dongle")}>
          <Icon n="chev" class={`chev ${closed.includes("dongle") ? "" : "open"}`} size={16} /><span class="dot acc" /><h3>Dongle &amp; connection</h3><span class="cnt">8</span>
        </div>
        {!closed.includes("dongle") && (
          <div class="grid auto-sm" style={{ marginTop: 10 }}>
            {[
              ["Wi-Fi signal", h ? `${h.wifi.rssi}` : null, "dBm"],
              ["Dongle uptime", h ? dur(h.uptimeS) : null, ""],
              ["Free memory", h ? `${(h.mem.freeHeap / 1024).toFixed(1)}` : null, "KB"],
              ["Last poll duration", h ? `${h.modbus.lastPollMs}` : null, "ms"],
              ["Poll success", h ? `${((h.modbus.ok / Math.max(1, h.modbus.ok + h.modbus.fail)) * 100).toFixed(2)}` : null, "%"],
              ["Consecutive failures", h ? `${h.modbus.consecutiveFail}` : null, ""],
              ["History storage used", h ? `${((h.storage.used / h.storage.total) * 100).toFixed(1)}` : null, "%"],
              ["Firmware", h ? h.fw : null, ""],
            ].map(([n, v, u]) => (
              <div class={`mcard ${dense === "compact" ? "compact" : ""}`} key={n as string}>
                <div class="top2"><span class="nm">{n}</span></div>
                <div class="val num" style={v == null ? { color: "var(--faint)", fontSize: 16 } : {}}>{v ?? "Unavailable"}{v != null && u && <span class="u">{u}</span>}</div>
                {dense === "detail" && <div class="meta"><span>dongle</span><span>updates every 30 s</span></div>}
              </div>
            ))}
          </div>
        )}
      </section>

      {unavailable.length > 0 && (
        <Card title="Unavailable on this inverter" sub="Kept visible so nothing is silently hidden">
          <div class="list">
            {unavailable.map((ch) => <div class="li" key={ch.id}><span>{ch.name}</span><span class="small faint">{unavailableReason(ch, value(ch), online)}</span></div>)}
          </div>
        </Card>
      )}
      <Card title="Not applicable to your system">
        <p class="small muted" style={{ margin: 0 }}>
          Battery (state of charge, charge/discharge power, battery voltage), phases L2/L3 and PV4–PV8 aren't shown: you have no battery, and the MIN 8000TL-X is single-phase with three MPPT inputs. Household consumption is only available as unverified meter data (see <i>Grid meter</i>).
        </p>
      </Card>

      {info && (
        <Modal title={info.name} onClose={() => setInfo(null)}>
          <div class="kv">
            <span>Current value</span><span class="num">{(() => { const v = value(info); const fv = fmtValue(v, info.unit); return v == null ? "Unavailable" : `${fv.v} ${fv.u}`; })()}</span>
            <span>Description</span><span>{info.desc}</span>
            <span>Quality</span><span><QualityBadge q={info.quality} /> <span class="small faint">{QUALITY_HELP[info.quality]}</span></span>
            <span>Source</span><span>{info.cat === "meter" ? "Grid meter via inverter" : "Inverter"} · input register {info.reg} ({info.type})</span>
            <span>Scaling</span><span class="num">raw × {info.scale}{info.unit ? ` → ${info.unit}` : ""}</span>
            <span>Kind</span><span>{{ power: "Instantaneous power", instant: "Instantaneous value", counter_day: "Daily energy counter (resets each day)", counter_total: "Lifetime counter", code: "Code / raw value", status: "Status" }[info.kind]}</span>
            <span>History</span><span>{stored.has(info.id) ? "Logged every minute (≈18 days) and as 15-minute averages (≈4 months)" : info.kind === "counter_day" ? "Logged in the 15-minute tier and daily summaries" : "Live only"}</span>
            <span>Identifier</span><span class="num">{info.id}</span>
          </div>
          <div class="row" style={{ marginTop: 16, gap: 8 }}>
            <button class="btn pri" onClick={() => openInExplorer([info.id], stored.has(info.id) ? "today" : "live")}><Icon n="explorer" size={15} />Chart it</button>
          </div>
        </Modal>
      )}
    </>
  );
}
