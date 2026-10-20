import { efficiency, pctChange, shares, sumDays } from "../analytics";
import { Chart, Legend } from "../chart";
import { days, history } from "../data";
import { fmtPct, fmtStr, fmtValue, scaleUnit, statusOf } from "../format";
import { go, openInExplorer } from "../nav";
import { PinnedViews } from "./explorer";
import { freshness, sampleAge, useStore, val } from "../state";
import { DAY, ago, dayStart, fmtMonth, fmtTime, minToTime, monthStart, nowS, weekStart, yearStart, ymd } from "../time";
import { Card, Empty, Icon, QualityBadge, Stat, useAsync } from "../ui";

export const PV_COLORS = ["#55c7f7", "#a78bfa", "#fbbf24"];

export function Overview() {
  const s = useStore();
  const meta = s.meta!;
  const now = nowS();
  const today = dayStart(now);
  const f = freshness();
  const online = f === "live" || f === "stale";
  const pac = val("pac");
  const st = statusOf(val("status"), online);

  // Today + yesterday power at 1-minute resolution, refreshed every minute.
  const curve = useAsync(async () => {
    const [t, y] = await Promise.all([
      history(meta, [{ id: "pac" }], today, now, "1m"),
      history(meta, [{ id: "pac" }], today - DAY, today - 1, "1m"),
    ]);
    return { t, y };
  }, [today], 60000);

  // Yesterday's energy counter at the same time of day (15-min tier).
  const yday = useAsync(() => history(meta, [{ id: "eac_today", agg: "last" }], today - DAY, now - DAY, "15m"), [Math.floor(now / 900)]);
  const dayRows = useAsync(() => days(Math.min(ymd(yearStart(now)), ymd(today - 40 * DAY))), [today], 300000);

  const eacToday = val("eac_today");
  const ydayAtTime = (() => {
    const c = yday.data?.cols[0];
    if (!c) return null;
    for (let i = c.length - 1; i >= 0; i--) if (c[i] != null) return c[i];
    return null;
  })();
  const vsY = pctChange(eacToday, ydayAtTime);
  const drows = dayRows.data ?? [];
  const todayRow = drows.find((d) => d.date === ymd(now));
  // Logging started part-way through today if the inverter's own day counter
  // is well above what the lifetime counter advanced while we were logging.
  const partialToday = !!todayRow && todayRow.eac / 10 - (todayRow.eacTotalLast - todayRow.eacTotalFirst) / 10 > 0.5;
  const sinceLog = partialToday && todayRow ? ` · logged since ${minToTime(todayRow.firstGenMin === 0xffff ? 0 : todayRow.firstGenMin)}` : "";
  const month = sumDays(drows, ymd(monthStart(now)), ymd(now));
  const week = sumDays(drows, ymd(weekStart(now)), ymd(now));
  const year = sumDays(drows, ymd(yearStart(now)), ymd(now));
  const oldest = drows.length ? drows[0].date : null;
  const partialNote = (from: number) => (oldest && oldest > ymd(from) ? " · since logging began" : "");

  // Chart data: shift yesterday by +24h so both share a time axis.
  const cd = curve.data;
  const xs: number[] = [];
  const ysToday: (number | null)[] = [];
  const ysY: (number | null)[] = [];
  if (cd) {
    const map = new Map<number, [number | null, number | null]>();
    cd.t.t.forEach((t, i) => map.set(t, [cd.t.cols[0][i], map.get(t)?.[1] ?? null]));
    cd.y.t.forEach((t, i) => { const k = t + DAY; map.set(k, [map.get(k)?.[0] ?? null, cd.y.cols[0][i]]); });
    // live tail: append the latest live reading so the curve reaches "now"
    if (pac != null && f === "live" && s.live) map.set(s.live.t, [pac, map.get(s.live.t)?.[1] ?? null]);
    [...map.keys()].sort((a, b) => a - b).forEach((k) => {
      xs.push(k);
      ysToday.push(map.get(k)![0]);
      ysY.push(map.get(k)![1]);
    });
  }
  const peakW = Math.max(1, ...ysToday.map((v) => v ?? 0), ...ysY.map((v) => v ?? 0));
  const u = scaleUnit("W", peakW);
  const hasCurve = xs.length > 1;
  const firstT = hasCurve ? xs[0] : today + 5 * 3600;
  const xr: [number, number] = [Math.min(today + 5 * 3600, firstT), Math.max(today + 19 * 3600, now)];

  const ppv = ["ppv1", "ppv2", "ppv3"].map(val);
  const sh = shares(ppv);

  return (
    <>
      <div class="grid g4">
        <Stat label="Live production" value={pac} unit="W" tone={online ? (pac && pac > 0 ? "acc" : "warn") : ""}
          foot={online ? (pac && pac > 0 ? "Generating" : st.label) : "Offline"} onClick={() => openInExplorer(["pac", "ppv"], "today")} />
        <Stat label="Energy today" value={eacToday} unit="kWh" tone={vsY == null ? "" : vsY >= 0 ? "ok" : "warn"}
          foot={vsY == null ? (eacToday == null ? "Waiting for inverter" : "No comparison yet") : `${vsY >= 0 ? "+" : ""}${vsY.toFixed(1)}% vs yesterday`}
          onClick={() => go("energy")} />
        <Stat label={partialToday ? "Peak output (logged)" : "Peak output"} value={todayRow?.pacPeak || null} unit="W" tone="warn"
          foot={todayRow?.pacPeak ? `${minToTime(todayRow.pacPeakMin)}${sinceLog}` : "Not yet today"} onClick={() => openInExplorer(["pac"], "today")} />
        <Stat label="Monthly energy" value={month.kwh} unit="kWh" tone="pur" foot={`${fmtMonth(now).split(" ")[0]} total${partialNote(monthStart(now))}`} onClick={() => go("energy")} />
      </div>
      <div class="grid g4">
        <Stat sm label="This week" value={week.kwh} unit="kWh" foot={`${week.days} day${week.days === 1 ? "" : "s"} logged${partialNote(weekStart(now))}`} onClick={() => go("energy")} />
        <Stat sm label="This year" value={year.kwh} unit="kWh" foot={`${year.days} day${year.days === 1 ? "" : "s"} logged${partialNote(yearStart(now))}`} onClick={() => go("energy")} />
        <Stat sm label="Lifetime generation" value={val("eac_total")} unit="kWh" foot="Inverter counter" onClick={() => openInExplorer(["eac_today"], "30d")} />
        <Stat sm label="Inverter status" value={null} unit="" text={st.label} tone={st.tone}
          foot={online ? `Temp ${fmtStr(val("tinv"), "°C")}` : "No connection"} onClick={() => go("diagnostics")} />
      </div>

      <Card title="Power output" sub="Daily generation profile" right={<span class="small" style={{ color: "#55c7f7" }}>{u.unit}</span>}>
        {curve.err && !hasCurve ? <Empty h={300}>Could not load history: {curve.err}</Empty> :
          !hasCurve ? <Empty h={300}>{curve.loading ? "Loading…" : "No generation recorded yet today. The curve appears once the inverter starts producing."}</Empty> : (
          <>
            <Chart height={300} x={xs} ys={[ysToday, ysY]} xRange={xr} gapSec={300}
              axes={[{ key: "p", label: u.unit, side: "left", fmt: (v) => (v / u.div).toFixed(u.div > 1 ? 1 : 0), min: 0 }]}
              series={[
                { label: "Today", color: "#55c7f7", axis: "p", style: "area", smooth: true, width: 3, fmt: (v) => fmtStr(v, "W") },
                { label: "Yesterday", color: "#7b8799", axis: "p", dash: true, smooth: true, width: 2, fmt: (v) => fmtStr(v, "W") },
              ]} />
            <Legend items={[{ label: "Today", color: "#55c7f7" }, { label: "Yesterday", color: "#7b8799", dash: true }]} />
          </>
        )}
      </Card>

      <div class="grid g3">
        <Card title="MPPT inputs" sub="Live DC power per tracker" right={<button class="btn sm ghost" onClick={() => go("mppt")}>Details</button>}>
          {[0, 1, 2].map((i) => {
            const v = ppv[i];
            const volts = val(`vpv${i + 1}`);
            const idle = volts != null && volts < 30 && (val(`epv${i + 1}_total`) ?? 1) === 0;
            return (
              <div style={{ marginBottom: 14 }} key={i}>
                <div class="row between small" style={{ marginBottom: 6 }}>
                  <span class="row"><span class="dot" style={{ background: PV_COLORS[i] }} />PV{i + 1}{idle && <span class="faint">· no string detected</span>}</span>
                  <span class="num">{fmtStr(v, "W")} <span class="faint">{fmtPct(sh[i], 0)}</span></span>
                </div>
                <div class="bar" style={{ "--c": PV_COLORS[i] }}><i style={{ width: `${Math.min(100, ((v ?? 0) / 5000) * 100)}%` }} /></div>
              </div>
            );
          })}
          <div class="list small">
            <div class="li"><span>Total DC input</span><span class="num">{fmtStr(val("ppv"), "W")}</span></div>
            <div class="li"><span>Conversion efficiency <span class="faint">(calculated)</span></span><span class="num">{fmtPct(efficiency(pac, val("ppv")))}</span></div>
            <div class="li"><span>Conversion loss <span class="faint">(DC − AC)</span></span><span class="num">{fmtStr(pac != null && val("ppv") != null ? Math.max(0, val("ppv")! - pac) : null, "W")}</span></div>
          </div>
        </Card>

        <Card title="Inverter diagnostics" right={<span class={`row small ${st.tone === "ok" ? "q-verified" : st.tone === "err" ? "" : "muted"}`} style={st.tone === "err" ? { color: "var(--err)" } : {}}><Icon n="check" size={15} />{st.label}</span>}>
          <div class="list">
            <div class="li"><span>AC voltage</span><span class="num">{fmtStr(val("vac"), "V")}</span></div>
            <div class="li"><span>Grid frequency</span><span class="num">{fmtStr(val("fac"), "Hz")}</span></div>
            <div class="li"><span>Inverter temperature</span><span class="num">{fmtStr(val("tinv"), "°C")}</span></div>
            <div class="li"><span>Fault / warning</span><span class="num">{online ? `${val("fault") || "None"} / ${val("warn") || "None"}` : "—"}</span></div>
            <div class="li"><span>Last reading</span><span class="num">{isFinite(sampleAge()) ? ago(sampleAge()) : "—"}</span></div>
          </div>
        </Card>

        <Card title="Communication" sub="Dongle and Modbus link" right={<button class="btn sm ghost" onClick={() => go("diagnostics")}>Details</button>}>
          <div class="list">
            <div class="li"><span>Inverter link</span><span>{s.health?.modbus.link ? <span class="q-verified">Connected</span> : <span class="muted">Not connected</span>}</span></div>
            <div class="li"><span>Wi-Fi signal</span><span class="num">{s.health ? `${s.health.wifi.rssi} dBm` : "—"}</span></div>
            <div class="li"><span>Poll interval</span><span class="num">{s.health ? `${(s.health.modbus.currentFastMs / 1000).toFixed(0)} s / ${(s.health.modbus.slowMs / 1000).toFixed(0)} s` : "—"}</span></div>
            <div class="li"><span>Poll success</span><span class="num">{s.health ? fmtPct((s.health.modbus.ok / Math.max(1, s.health.modbus.ok + s.health.modbus.fail)) * 100, 2) : "—"}</span></div>
            <div class="li"><span>Time source</span><span>{s.live ? (s.live.time === "ntp" ? "Internet (NTP)" : s.live.time === "inverter" ? "Inverter clock" : "None") : "—"}</span></div>
          </div>
        </Card>
      </div>

      <div class="grid g2">
        <Card title="Today at a glance" sub="From the inverter's own counters and today's log">
          <div class="list">
            <div class="li"><span>{partialToday ? "Logging started" : "First generation"}</span><span class="num">{todayRow ? minToTime(todayRow.firstGenMin) : "—"}</span></div>
            <div class="li"><span>Generating time{partialToday ? " (logged)" : ""}</span><span class="num">{todayRow ? `${Math.floor(todayRow.genMin / 60)} h ${todayRow.genMin % 60} min` : "—"}</span></div>
            <div class="li"><span>PV1 / PV2 / PV3 today</span><span class="num">{["epv1_today", "epv2_today", "epv3_today"].map((k) => fmtValue(val(k), "kWh").v).join(" / ")} kWh</span></div>
            <div class="li"><span>Yesterday total</span><span class="num">{fmtStr(drows.find((d) => d.date === ymd(today - DAY))?.eac != null ? drows.find((d) => d.date === ymd(today - DAY))!.eac / 10 : null, "kWh")}</span></div>
            <div class="li"><span>Output vs 8 kW rating</span><span class="num">{fmtPct(val("opct"), 0)}</span></div>
          </div>
        </Card>
        <Card title="Grid meter" sub="Meter-derived values reported by the inverter" right={<QualityBadge q="unverified" />}>
          <div class="list">
            <div class="li"><span>Export to grid</span><span class="num">{fmtStr(val("pexp"), "W")}</span></div>
            <div class="li"><span>Import from grid</span><span class="num">{fmtStr(val("pimp"), "W")}</span></div>
            <div class="li"><span>Household load</span><span class="num">{fmtStr(val("pload"), "W")}</span></div>
            <div class="li"><span>Exported today</span><span class="num">{fmtStr(val("eexp_today"), "kWh")}</span></div>
          </div>
          <p class="foot-note" style={{ margin: "10px 0 0" }}>These don't fully balance yet (load reads 40–100 W above output − export), and they only count while the inverter is on. They're shown for reference and aren't used in any calculation.</p>
        </Card>
      </div>
      <PinnedViews />
      <p class="foot-note">Times are Australia/Brisbane. "Calculated" values are derived in your browser from measured data. Unavailable values are shown as "—", never as zero.</p>
    </>
  );
}
