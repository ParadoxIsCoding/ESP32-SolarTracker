import { useState } from "preact/hooks";
import { dayValue, sumDays, type DayValue, type Rates } from "../analytics";
import { api, type Day } from "../api";
import { Chart, Legend } from "../chart";
import { days } from "../data";
import { fmtStr } from "../format";
import { useStore, val } from "../state";
import {
  DAY, dayStart, fmtDay, fmtMonth, minToTime, monthStart, nowS, weekStart, yearStart, ymd, ymdToEpoch,
} from "../time";
import { Card, Empty, Seg, Stat, download, useAsync } from "../ui";

type P = "30d" | "month" | "year" | "all";

export function Energy() {
  useStore();
  const now = nowS();
  const today = dayStart(now);
  const [p, setP] = useState<P>("30d");
  const rows = useAsync(() => days(20240101), [today], 300000);
  const cfg = useAsync(() => api.settings(), []);
  const all = rows.data ?? [];
  const start = p === "30d" ? ymd(today - 29 * DAY) : p === "month" ? ymd(monthStart(now)) : p === "year" ? ymd(yearStart(now)) : 0;
  const sel = all.filter((d) => d.date >= start);
  const total = sumDays(sel, start, 99999999);
  const best = sel.reduce<Day | null>((b, d) => (!d.partial && (!b || d.eac > b.eac) ? d : b), null);
  const complete = sel.filter((d) => !d.partial);
  const avg = complete.length ? complete.reduce((s, d) => s + d.eac, 0) / complete.length / 10 : null;

  // monthly aggregation for the long views
  const months = new Map<number, number>();
  for (const d of sel) months.set(Math.floor(d.date / 100), (months.get(Math.floor(d.date / 100)) ?? 0) + d.eac / 10);
  const monthly = p === "year" || p === "all";

  const c = cfg.data;
  const tariff = c?.tariffExport ?? 0;
  const co2 = c?.co2PerKwh ?? 0;
  const rates: Rates = { usage: c?.tariffImport ?? 0, feed1: tariff, feed2: c?.tariffExport2 || tariff, tierKwh: c?.exportTier1Kwh ?? 0 };
  const vOf = (d: Day): DayValue | null => dayValue(d.eac / 10, d.eexp / 10, d.eimp / 10, d.eload / 10, rates);
  const vals = sel.map(vOf);
  const metered = vals.filter((v): v is DayValue => v != null);
  const sumV = (k: keyof DayValue) => metered.reduce((s, v) => s + ((v[k] as number) ?? 0), 0);
  const tot = { gen: sumV("generated"), exp: sumV("exported"), self: sumV("selfUsed"), feed: sumV("feedIn"), avoided: sumV("avoided"), total: sumV("total") };
  const importDay = sel.reduce((s, d) => s + d.eimp / 10, 0);
  const money = (x: number) => `$${x.toFixed(2)}`;

  const csv = () => {
    const head = "date,ac_kwh,exported_kwh,self_used_kwh,import_daytime_kwh,load_daytime_kwh,value_aud,pv1_kwh,pv2_kwh,pv3_kwh,efficiency_pct,peak_w,peak_time,first_gen,last_gen,generating_min,max_temp_c,lifetime_end_kwh,partial";
    const lines = all.map((d) => { const v = vOf(d); return [d.date, d.eac / 10, v ? v.exported.toFixed(1) : "", v ? v.selfUsed.toFixed(1) : "", d.eimp / 10, d.eload / 10, v ? v.total.toFixed(2) : "", d.epv1 / 10, d.epv2 / 10, d.epv3 / 10, d.epv1 + d.epv2 + d.epv3 > 20 ? ((d.eac / (d.epv1 + d.epv2 + d.epv3)) * 100).toFixed(1) : "", d.pacPeak, minToTime(d.pacPeakMin), minToTime(d.firstGenMin), minToTime(d.lastGenMin), d.genMin, d.tinvMax === -32768 ? "" : d.tinvMax / 10, d.eacTotalLast / 10, d.partial].join(","); });
    download(`solar_daily_${ymd(now)}.csv`, [head, ...lines].join("\n"));
  };

  return (
    <>
      <div class="grid g4">
        <Stat label="Today" value={val("eac_today")} unit="kWh" tone="acc" foot="Inverter day counter" />
        <Stat label="This week" value={sumDays(all, ymd(weekStart(now)), ymd(now)).kwh} unit="kWh" tone="ok" foot="Since Monday" />
        <Stat label="This month" value={sumDays(all, ymd(monthStart(now)), ymd(now)).kwh} unit="kWh" tone="pur" foot={fmtMonth(now)} />
        <Stat label="Lifetime" value={val("eac_total")} unit="kWh" tone="warn" foot="Inverter lifetime counter" />
      </div>

      <Card title={monthly ? "Monthly generation" : "Daily generation"} sub={`${total.days} day${total.days === 1 ? "" : "s"} logged · ${fmtStr(total.kwh, "kWh")} total`}
        right={<div class="row wrap" style={{ gap: 8 }}>
          <Seg value={p} options={[["30d", "30 days"], ["month", "This month"], ["year", "This year"], ["all", "All logged"]]} onChange={setP} />
          <button class="btn sm ghost" onClick={csv} disabled={!all.length}>CSV</button>
        </div>}>
        {!sel.length ? <Empty h={280}>{rows.loading ? "Loading…" : "No daily summaries yet. A summary is recorded for every day the inverter runs."}</Empty> : monthly ? (
          <Chart height={280} xKind="day" x={[...months.keys()].map((m) => ymdToEpoch(m * 100 + 1))} ys={[[...months.values()]]}
            axes={[{ key: "kWh", label: "kWh", side: "left", fmt: (v) => v.toFixed(0), min: 0 }]}
            series={[{ label: "Generation", color: "#55c7f7", axis: "kWh", style: "bars", fmt: (v) => fmtStr(v, "kWh") }]} />
        ) : (
          <>
            <Chart height={280} xKind="day" x={sel.map((d) => ymdToEpoch(d.date))}
              xRange={p === "30d" ? [today - 29 * DAY - 43200, today + 43200] : p === "month" ? [monthStart(now) - 43200, today + 43200] : undefined}
              ys={[sel.map((d) => d.eac / 10), sel.map((d, i) => (vals[i] ? vals[i]!.exported : null)), sel.map((d, i) => (vals[i] ? d.eimp / 10 : null))]}
              axes={[{ key: "kWh", label: "kWh", side: "left", fmt: (v) => v.toFixed(0), min: 0 }]}
              series={[
                { label: "Generated", color: "#55c7f7", axis: "kWh", style: "bars", fmt: (v) => fmtStr(v, "kWh") },
                { label: "Exported", color: "#a78bfa", axis: "kWh", style: "bars", barSize: 0.38, fmt: (v) => fmtStr(v, "kWh") },
                { label: "Grid import (daytime)", color: "#f87171", axis: "kWh", style: "line", fmt: (v) => fmtStr(v, "kWh") },
              ]} />
            <Legend items={[{ label: "Generated", color: "#55c7f7" }, { label: "Exported (meter)", color: "#a78bfa" }, { label: "Grid import while inverter on (meter)", color: "#f87171" }]} />
          </>
        )}
      </Card>

      <div class="grid g3">
        <Stat sm label="Best day in period" value={best ? best.eac / 10 : null} unit="kWh" foot={best ? fmtDay(ymdToEpoch(best.date) + 43200) : "—"} />
        <Stat sm label="Average per complete day" value={avg} unit="kWh" foot={`${complete.length} complete days`} />
        <Stat sm label="Specific yield (avg)" value={avg != null ? avg / 8 : null} unit="kWh" foot="Per kW of inverter rating, per day (calculated)" />
      </div>

      <Card title="Solar value" sub={`${metered.length} of ${sel.length} days with meter data · grid meter readings (live-tested, accuracy not yet verified)`}>
        {!c ? <Empty h={100}>Loading rates…</Empty> : !metered.length ? <Empty h={100}>No meter data in this period yet.</Empty> : (
          <>
            <div class="grid g4">
              <Stat sm label="Generated" value={tot.gen} unit="kWh" tone="acc" foot={`${metered.length} metered days`} />
              <Stat sm label="Used at home" value={tot.self} unit="kWh" tone="ok" foot={`${tot.gen ? ((tot.self / tot.gen) * 100).toFixed(0) : "—"}% self-consumption · saves ${(rates.usage * 100).toFixed(2)} c/kWh`} />
              <Stat sm label="Exported" value={tot.exp} unit="kWh" tone="pur" foot={rates.tierKwh > 0 ? `First ${rates.tierKwh} kWh/day at ${(rates.feed1 * 100).toFixed(0)} c, rest ${(rates.feed2 * 100).toFixed(0)} c` : `${(rates.feed1 * 100).toFixed(1)} c/kWh`} />
              <Stat sm label="Total solar value" value={tot.total} unit="" text={money(tot.total)} tone="ok" foot={`${money(tot.avoided)} saved + ${money(tot.feed)} feed-in`} />
            </div>
            <div class="grid g3" style={{ marginTop: 16 }}>
              <Stat sm label="Average value per day" value={tot.total / metered.length} unit="" text={money(tot.total / metered.length)} foot="Metered days in this period" />
              <Stat sm label="Grid import while inverter on" value={importDay} unit="kWh" foot={rates.usage ? `${money(importDay * rates.usage)} at your usage rate · night not visible` : "Night-time import isn't visible"} />
              {co2 > 0 ? <Stat sm label="Estimated CO₂ avoided" value={tot.gen * co2} unit="" text={`${(tot.gen * co2).toFixed(0)} kg`} foot={`${co2.toFixed(2)} kg CO₂-e per kWh (grid factor)`} /> :
                <Stat sm label="Supply charges, same days" value={null} unit="" text={money((c.supplyPerDay ?? 0) * sel.length)} foot="Paid regardless of solar" />}
            </div>
            <p class="foot-note" style={{ marginBottom: 0 }}>
              Per day: used at home = generated − exported, valued at your usage rate (energy you didn't buy); exports earn the tiered feed-in rate. Exports come straight from the meter, not estimated. Daily supply charges ({money(c.supplyPerDay)}/day) are paid with or without solar, so they're not included. The stick only sees the grid while the inverter is on, so overnight imports (most of your bill) aren't included.
            </p>
          </>
        )}
      </Card>

      <Card title="Daily log" sub="Newest first">
        {!sel.length ? <Empty h={120}>No days logged yet.</Empty> : (
          <div class="scroll-x">
            <table class="t">
              <thead><tr><th>Day</th><th class="r">Generated</th><th class="r">Exported</th><th class="r">Used at home</th><th class="r">Import (day)</th><th class="r">Value</th><th class="r">PV1 / PV2 / PV3</th><th class="r">Peak</th><th class="r">Peak time</th><th class="r">Efficiency</th><th class="r">Generating</th><th class="r">Max temp</th></tr></thead>
              <tbody>
                {sel.slice().reverse().map((d) => (
                  <tr key={d.date}>
                    <td>{fmtDay(ymdToEpoch(d.date) + 43200)}{d.partial ? <span class="faint"> · so far</span> : ""}{d.flags ? <span class="chip warn" style={{ marginLeft: 6 }} title="The inverter's counter reset or went backwards during this day; the larger value was kept.">counter note</span> : null}</td>
                    <td class="r num">{(d.eac / 10).toFixed(1)} kWh</td>
                    {(() => { const v = vOf(d); return v ? <>
                      <td class="r num">{v.exported.toFixed(1)}</td><td class="r num">{v.selfUsed.toFixed(1)}</td><td class="r num">{(d.eimp / 10).toFixed(1)}</td><td class="r num">{money(v.total)}</td>
                    </> : <><td class="r faint">—</td><td class="r faint">—</td><td class="r faint">—</td><td class="r faint">—</td></>; })()}
                    <td class="r num">{(d.epv1 / 10).toFixed(1)} / {(d.epv2 / 10).toFixed(1)} / {(d.epv3 / 10).toFixed(1)}</td>
                    <td class="r num">{fmtStr(d.pacPeak || null, "W")}</td>
                    <td class="r num">{minToTime(d.pacPeakMin)}</td>
                    <td class="r num" title="AC energy ÷ PV energy from the inverter's day counters">{d.epv1 + d.epv2 + d.epv3 > 20 ? `${((d.eac / (d.epv1 + d.epv2 + d.epv3)) * 100).toFixed(1)}%` : "—"}</td>
                    <td class="r num">{Math.floor(d.genMin / 60)} h {d.genMin % 60} m</td>
                    <td class="r num">{d.tinvMax === -32768 ? "—" : `${(d.tinvMax / 10).toFixed(1)} °C`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p class="foot-note">Daily totals come from the inverter's own day counter (last value before it resets), not from integrating power. Days before logging began aren't available; the inverter's lifetime counter covers all time. Period boundaries use Brisbane time.</p>
    </>
  );
}
