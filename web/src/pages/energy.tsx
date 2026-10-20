import { useState } from "preact/hooks";
import { feedInValue, sumDays } from "../analytics";
import { api, type Day } from "../api";
import { Chart } from "../chart";
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
  const fit = feedInValue(sel.map((d) => d.eac / 10), tariff, c?.tariffExport2 ?? tariff, c?.exportTier1Kwh ?? 0);
  const fitLabel = c && c.exportTier1Kwh > 0 && c.tariffExport2 > 0
    ? `First ${c.exportTier1Kwh} kWh/day at ${(c.tariffExport * 100).toFixed(1)} c, rest at ${(c.tariffExport2 * 100).toFixed(1)} c`
    : `${fmtStr(total.kwh, "kWh")} × ${(tariff * 100).toFixed(1)} c/kWh`;

  const csv = () => {
    const head = "date,ac_kwh,pv1_kwh,pv2_kwh,pv3_kwh,efficiency_pct,peak_w,peak_time,first_gen,last_gen,generating_min,max_temp_c,lifetime_end_kwh,partial";
    const lines = all.map((d) => [d.date, d.eac / 10, d.epv1 / 10, d.epv2 / 10, d.epv3 / 10, d.epv1 + d.epv2 + d.epv3 > 20 ? ((d.eac / (d.epv1 + d.epv2 + d.epv3)) * 100).toFixed(1) : "", d.pacPeak, minToTime(d.pacPeakMin), minToTime(d.firstGenMin), minToTime(d.lastGenMin), d.genMin, d.tinvMax === -32768 ? "" : d.tinvMax / 10, d.eacTotalLast / 10, d.partial].join(","));
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
          <Chart height={280} xKind="day" x={sel.map((d) => ymdToEpoch(d.date))} ys={[sel.map((d) => d.eac / 10)]}
            axes={[{ key: "kWh", label: "kWh", side: "left", fmt: (v) => v.toFixed(0), min: 0 }]}
            series={[{ label: "Generation", color: "#55c7f7", axis: "kWh", style: "bars", fmt: (v) => fmtStr(v, "kWh") }]} />
        )}
      </Card>

      <div class="grid g3">
        <Stat sm label="Best day in period" value={best ? best.eac / 10 : null} unit="kWh" foot={best ? fmtDay(ymdToEpoch(best.date) + 43200) : "—"} />
        <Stat sm label="Average per complete day" value={avg} unit="kWh" foot={`${complete.length} complete days`} />
        <Stat sm label="Specific yield (avg)" value={avg != null ? avg / 8 : null} unit="kWh" foot="Per kW of inverter rating, per day (calculated)" />
      </div>

      {(tariff > 0 || co2 > 0 || (c?.tariffImport ?? 0) > 0) && (
        <Card title="Estimates" sub="Based on the assumptions you entered in Settings">
          <div class="grid g3">
            {tariff > 0 && <Stat sm label="If all generation were exported" value={total.kwh != null ? fit : null} unit="" text={total.kwh != null ? `$${fit.toFixed(2)}` : undefined} foot={fitLabel} />}
            {c && c.tariffImport > 0 && <Stat sm label="If all generation offset imports" value={total.kwh != null ? total.kwh * c.tariffImport : null} unit="" text={total.kwh != null ? `$${(total.kwh * c.tariffImport).toFixed(2)}` : undefined} foot={`Upper bound · ${(c.tariffImport * 100).toFixed(3)} c/kWh usage rate`} />}
            {c && c.supplyPerDay > 0 && <Stat sm label="Supply charges over the same days" value={null} unit="" text={`$${(c.supplyPerDay * total.days).toFixed(2)}`} foot={`${total.days} days × ${(c.supplyPerDay * 100).toFixed(3)} c/day (paid regardless of solar)`} />}
            {co2 > 0 && <Stat sm label="Estimated CO₂ avoided" value={total.kwh != null ? total.kwh * co2 : null} unit="" text={total.kwh != null ? `${(total.kwh * co2).toFixed(0)} kg` : undefined} foot={`${co2} kg CO₂-e per kWh (grid factor)`} />}
          </div>
          <p class="foot-note" style={{ marginBottom: 0 }}>Your real benefit sits between these two bounds: every kWh used at home avoids the usage rate, and every kWh exported earns the feed-in rate. The split needs verified meter data, so no single "savings" figure is shown.</p>
        </Card>
      )}

      <Card title="Daily log" sub="Newest first">
        {!sel.length ? <Empty h={120}>No days logged yet.</Empty> : (
          <div class="scroll-x">
            <table class="t">
              <thead><tr><th>Day</th><th class="r">Generated</th><th class="r">PV1 / PV2 / PV3</th><th class="r">Peak</th><th class="r">Peak time</th><th class="r">Efficiency</th><th class="r">Generating</th><th class="r">Max temp</th></tr></thead>
              <tbody>
                {sel.slice().reverse().map((d) => (
                  <tr key={d.date}>
                    <td>{fmtDay(ymdToEpoch(d.date) + 43200)}{d.partial ? <span class="faint"> · so far</span> : ""}{d.flags ? <span class="chip warn" style={{ marginLeft: 6 }} title="The inverter's counter reset or went backwards during this day; the larger value was kept.">counter note</span> : null}</td>
                    <td class="r num">{(d.eac / 10).toFixed(1)} kWh</td>
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
