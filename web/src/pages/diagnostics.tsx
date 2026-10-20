import { useState } from "preact/hooks";
import { api } from "../api";
import { fmtBytes, fmtStr, statusOf } from "../format";
import { chanIndex, freshness, useStore, val } from "../state";
import { dur, fmtDateTime, fmtYmd } from "../time";
import { Card, Empty, Icon, QualityBadge, Stat, download, useAsync } from "../ui";

const EVENT_NAMES: Record<number, string> = {
  1: "Dongle started", 2: "Clock synchronised (NTP)", 3: "Inverter link up", 4: "Inverter link down", 5: "Inverter status changed",
  6: "Fault code changed", 7: "Warning code changed", 8: "Energy counter anomaly", 9: "Day closed", 10: "Settings changed", 11: "Storage maintenance",
};
const PROTECTION = ["Under-voltage 1 (0.1 V)", "Over-voltage 1 (0.1 V)", "Under-frequency 1 (0.01 Hz)", "Over-frequency 1 (0.01 Hz)",
  "Under-voltage 2", "Over-voltage 2", "Under-frequency 2", "Over-frequency 2", "Stage 3 a", "Stage 3 b", "Stage 3 c", "Stage 3 d"];

function eventText(type: number, code: number, v: number) {
  switch (type) {
    case 5: return `${statusOf(v === 255 ? null : v, true).label} → ${statusOf(code, true).label}`;
    case 6: case 7: return `${v} → ${code}`;
    case 8: return `flags ${code}, day counter ${(v / 10).toFixed(1)} kWh`;
    case 9: return fmtYmd(v);
    case 11: return code === 1 ? "Oldest history file removed (retention)" : `Write problem (${v} records)`;
    default: return "";
  }
}

export function Diagnostics() {
  const s = useStore();
  const meta = s.meta!;
  const dev = useAsync(() => api.device(), [], 60000);
  const ev = useAsync(() => api.events(), [], 60000);
  const regs = useAsync(() => api.registers(), [], 15000);
  const files = useAsync(() => api.files(), [], 120000);
  const [rq, setRq] = useState("");
  const h = s.health;
  const d = dev.data;
  const f = freshness();
  const st = statusOf(val("status"), f === "live" || f === "stale");

  const exportLog = () => {
    const red = { ...h, wifi: h ? { ...h.wifi, ip: "redacted", mac: "redacted" } : undefined };
    const body = JSON.stringify({ exported: new Date().toISOString(), device: d ? { ...d, serial: d.serial ? d.serial.slice(0, 3) + "*******" : undefined } : null, health: red, events: ev.data }, null, 1);
    download("solar_diagnostics.json", body, "application/json");
  };

  const rows = (regs.data?.input ?? []).map((raw, i) => {
    const reg = 3000 + i;
    const ch = meta.channels.filter((c) => c.reg === reg);
    return { reg, raw, ch };
  }).filter((r) => r.ch.length && (!rq || `${r.reg} ${r.ch.map((c) => c.name).join(" ")}`.toLowerCase().includes(rq.toLowerCase())));

  return (
    <>
      <div class="grid g4">
        <Stat sm label="Inverter state" value={null} unit="" text={st.label} tone={st.tone} foot={`Fault ${val("fault") ?? "—"} · Warning ${val("warn") ?? "—"}`} />
        <Stat sm label="Modbus link" value={null} unit="" text={h?.modbus.link ? "Connected" : "Down"} tone={h?.modbus.link ? "ok" : "err"}
          foot={h ? `${h.modbus.ok.toLocaleString()} ok · ${h.modbus.fail} failed` : "—"} />
        <Stat sm label="Poll time" value={h?.modbus.lastPollMs ?? null} unit="" text={h ? `${h.modbus.lastPollMs} ms` : undefined} foot={h ? `max ${h.modbus.maxPollMs} ms · every ${h.modbus.currentFastMs / 1000} s` : "—"} />
        <Stat sm label="Dongle uptime" value={null} unit="" text={h ? dur(h.uptimeS) : "—"} foot={h ? `Reset: ${h.resetReason}` : "—"} />
      </div>

      <div class="grid g2">
        <Card title="Inverter" sub="Identity registers, read only" right={d?.readOnly ? <span class="chip ok"><Icon n="check" size={13} />Read-only firmware</span> : undefined}>
          {!d ? <Empty h={120}>{dev.loading ? "Loading…" : dev.err}</Empty> : !d.valid ? <Empty h={120}>Inverter identity not read yet.</Empty> : (
            <div class="list">
              <div class="li"><span>Model</span><span>Growatt MIN 8000TL-X <span class="faint">({d.model}, DTC {d.dtc})</span></span></div>
              <div class="li"><span>Serial number</span><span class="num">{d.serial}</span></div>
              <div class="li"><span>Firmware</span><span class="num">{d.fw} / {d.controlFw} <span class="faint">{d.fwBuild}</span></span></div>
              <div class="li"><span>Protocol</span><span class="small">{d.protocol} · Modbus v{((d.modbusVersion ?? 0) / 100).toFixed(2)}</span></div>
              <div class="li"><span>Trackers / phases (reported)</span><span class="num">{d.trackers} / {d.phases}</span></div>
              <div class="li"><span>Active power limit setting</span><span class="num">{d.activePowerRate}%</span></div>
              <div class="li"><span>Inverter clock</span><span class="num">{d.inverterClock}{d.clockDriftS != null && Math.abs(d.clockDriftS) > 60 && <span class="chip warn" style={{ marginLeft: 6 }}>{d.clockDriftS > 0 ? "+" : ""}{Math.round(d.clockDriftS / 60)} min vs internet time</span>}</span></div>
            </div>
          )}
          {d?.clockDriftS != null && Math.abs(d.clockDriftS) > 60 && <p class="foot-note" style={{ marginBottom: 0 }}>The dashboard never changes the inverter's clock (read-only). If you want, set it on the inverter itself. The dongle timestamps everything from internet time either way.</p>}
        </Card>

        <Card title="Dongle" sub="ShineWiFi-X (ESP8266EX, 4 MB)">
          {!h ? <Empty h={120}>Loading…</Empty> : (
            <div class="list">
              <div class="li"><span>Firmware</span><span class="num">{h.fw}</span></div>
              <div class="li"><span>Wi-Fi</span><span class="num">{h.wifi.rssi} dBm · ch {h.wifi.channel} · {h.wifi.ip}</span></div>
              <div class="li"><span>Free memory</span><span class="num">{fmtBytes(h.mem.freeHeap)} (largest block {fmtBytes(h.mem.maxBlock)}, {h.mem.fragPct}% fragmented)</span></div>
              <div class="li"><span>Firmware space</span><span class="num">{fmtBytes(h.mem.sketch)} used · {fmtBytes(h.mem.freeSketch)} free for updates</span></div>
              <div class="li"><span>Time source</span><span>{h.timeSource === "ntp" ? "Internet (NTP)" : h.timeSource === "inverter" ? "Inverter clock (fallback)" : "None yet"}</span></div>
              <div class="li"><span>Polling</span><span class="num">{h.modbus.fastMs / 1000} s fast · {h.modbus.slowMs / 1000} s slow{h.modbus.currentFastMs !== h.modbus.fastMs && <span class="chip warn" style={{ marginLeft: 6 }}>backing off</span>}</span></div>
            </div>
          )}
        </Card>
      </div>

      <div class="grid g2">
        <Card title="History storage" sub="LittleFS on the dongle's flash">
          {!h ? <Empty h={120}>Loading…</Empty> : (
            <>
              {[
                ["1-minute data", h.storage.h1Bytes, h.storage.h1Budget, `${h.storage.h1Files} days${h.storage.oldestH1Day ? ` · since ${fmtYmd(h.storage.oldestH1Day)}` : ""}`],
                ["15-minute data", h.storage.h15Bytes, h.storage.h15Budget, `${h.storage.h15Files} months`],
                ["Daily summaries", h.storage.dayBytes, h.storage.dayBudget, `${h.storage.dayFiles} files`],
              ].map(([n, used, budget, note]) => (
                <div style={{ marginBottom: 14 }} key={n as string}>
                  <div class="row between small" style={{ marginBottom: 6 }}><span>{n} <span class="faint">· {note}</span></span><span class="num muted">{fmtBytes(used as number)} / {fmtBytes(budget as number)}</span></div>
                  <div class="bar"><i style={{ width: `${Math.min(100, ((used as number) / (budget as number)) * 100)}%` }} /></div>
                </div>
              ))}
              <p class="foot-note" style={{ margin: 0 }}>Filesystem {fmtBytes(h.storage.used)} of {fmtBytes(h.storage.total)}. The oldest files are removed automatically when a tier is full. {h.storage.pendingMinutes} minute(s) are buffered in memory and written every 5 minutes.</p>
            </>
          )}
        </Card>

        <Card title="Grid protection settings" sub="Holding registers 52–63, raw values (labels unverified)">
          {!d?.protection ? <Empty h={120}>Not available.</Empty> : (
            <div class="list small">
              {d.protection.slice(0, 4).map((v, i) => (
                <div class="li" key={i}><span>{PROTECTION[i]}</span><span class="num">{i % 4 < 2 ? `${(v / 10).toFixed(1)} V` : `${(v / 100).toFixed(2)} Hz`}</span></div>
              ))}
              <div class="li"><span>Further stages (raw)</span><span class="num">{d.protection.slice(4).join(", ")}</span></div>
            </div>
          )}
        </Card>
      </div>

      <Card title="Event log" sub="Recorded on the dongle" right={<button class="btn sm ghost" onClick={exportLog}><Icon n="download" size={14} />Export (redacted)</button>}>
        {!ev.data?.length ? <Empty h={100}>{ev.loading ? "Loading…" : "No events yet."}</Empty> : (
          <div class="scroll-x" style={{ maxHeight: 320, overflow: "auto" }}>
            <table class="t">
              <thead><tr><th>Time</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody>{ev.data.slice().reverse().slice(0, 200).map(([t, type, code, v], i) => (
                <tr key={i}><td class="num">{t > 1.6e9 ? fmtDateTime(t) : "before clock sync"}</td><td>{EVENT_NAMES[type] ?? `Type ${type}`}</td><td class="muted">{eventText(type, code, v)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Register catalogue" sub="Every register the dashboard decodes: raw value from the last poll, decoding and verification status"
        right={<input class="input" placeholder="Filter" value={rq} onInput={(e) => setRq((e.target as HTMLInputElement).value)} style={{ width: 160 }} />}>
        {!regs.data ? <Empty h={120}>Loading…</Empty> : (
          <div class="scroll-x">
            <table class="t">
              <thead><tr><th>Reg</th><th>Measurement</th><th>Type</th><th class="r">Raw</th><th class="r">Scale</th><th class="r">Decoded</th><th>Status</th></tr></thead>
              <tbody>{rows.flatMap((r) => r.ch.map((ch) => {
                const v = s.live?.v[chanIndex(ch.id)];
                const raw = ch.type === "u32" || ch.type === "s32" ? (r.raw * 65536 + (regs.data!.input[r.reg - 3000 + 1] ?? 0)) : ch.type === "lo8" ? r.raw & 255 : ch.type === "hi8" ? r.raw >> 8 : r.raw;
                return (
                  <tr key={ch.id}>
                    <td class="num">{r.reg}{ch.type.endsWith("32") ? `–${r.reg + 1}` : ""}</td>
                    <td>{ch.name}</td><td class="faint">{ch.type}</td>
                    <td class="r num">{raw}</td><td class="r num">{ch.scale}</td>
                    <td class="r num">{fmtStr(v ?? null, ch.unit)}</td>
                    <td><QualityBadge q={ch.quality} /></td>
                  </tr>
                );
              }))}</tbody>
            </table>
          </div>
        )}
        <p class="foot-note" style={{ marginBottom: 0 }}>Source: Growatt Modbus RTU protocol v1.24 (TL-X input block 3000–3124) and OpenInverterGateway, cross-checked on 2026-10-20 against your inverter (serial matched the nameplate; PV and energy sums matched exactly). Only documented read-only registers are queried; there is no write path in the firmware.</p>
      </Card>

      <Card title="Backup" sub="Download the dongle's history files (read-only)">
        {!files.data?.length ? <Empty h={80}>{files.loading ? "Loading…" : "No history files yet."}</Empty> : (
          <div class="scroll-x" style={{ maxHeight: 240, overflow: "auto" }}>
            <table class="t">
              <thead><tr><th>File</th><th class="r">Size</th><th></th></tr></thead>
              <tbody>{files.data.map((f) => (
                <tr key={f.path}><td class="num">{f.path}</td><td class="r num">{fmtBytes(f.size)}</td><td class="r"><a href={`/api/file?path=${encodeURIComponent(f.path)}`} download>Download</a></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p class="foot-note" style={{ marginBottom: 0 }}>Files use a documented binary format (see docs/API.md). The original Growatt firmware backup is kept on your Mac in backups/.</p>
      </Card>
    </>
  );
}
