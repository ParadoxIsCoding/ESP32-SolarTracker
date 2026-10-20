import { useState } from "preact/hooks";
import { shares, stats } from "../analytics";
import { Chart, Legend } from "../chart";
import { days, history } from "../data";
import { fmtPct, fmtStr, scaleUnit } from "../format";
import { openInExplorer } from "../nav";
import { useStore, val } from "../state";
import { DAY, dayStart, fmtDateTime, fmtDay, nowS, ymd, ymdToEpoch } from "../time";
import { Card, Empty, Icon, Seg, useAsync } from "../ui";
import { PV_COLORS } from "./overview";

export function Mppt() {
  const s = useStore();
  const meta = s.meta!;
  const now = nowS();
  const today = dayStart(now);
  const [mode, setMode] = useState<"w" | "pct">("w");
  const [range, setRange] = useState<"today" | "yesterday" | "7d">("today");
  const [from, to] = range === "today" ? [today, now] : range === "yesterday" ? [today - DAY, today - 1] : [today - 6 * DAY, now];
  const h = useAsync(() => history(meta, ["ppv1", "ppv2", "ppv3"].map((id) => ({ id })), from, to), [range, Math.floor(now / 60)]);
  const d14 = useAsync(() => days(ymd(today - 13 * DAY)), [today], 300000);

  const live = [1, 2, 3].map((n) => ({ v: val(`vpv${n}`), i: val(`ipv${n}`), p: val(`ppv${n}`), e: val(`epv${n}_today`), tot: val(`epv${n}_total`) }));
  const sh = shares(live.map((x) => x.p));
  const todayRow = d14.data?.find((x) => x.date === ymd(now));
  const peaks = todayRow ? [todayRow.ppv1Peak, todayRow.ppv2Peak, todayRow.ppv3Peak] : [null, null, null];

  const hd = h.data;
  let ys = hd?.cols ?? [];
  if (hd && mode === "pct") {
    ys = [[], [], []];
    hd.t.forEach((_, k) => shares(hd.cols.map((c) => c[k])).forEach((v, j) => ys[j].push(v)));
  }
  const maxW = Math.max(1, ...(hd?.cols.flat().map((v) => v ?? 0) ?? [0]));
  const u = scaleUnit("W", maxW);

  return (
    <>
      <div class="grid g3">
        {live.map((x, i) => {
          const idle = x.v != null && x.v < 30 && (x.tot ?? 1) === 0;
          const st = hd ? stats(hd.t, hd.cols[i]) : null;
          return (
            <Card key={i} class="mppt" title={<span class="row"><span class="dot" style={{ background: PV_COLORS[i], width: 9, height: 9 }} />MPPT {i + 1}</span>}
              sub={idle ? "No string detected on this input" : "Live tracker values"}
              right={<button class="btn sm ghost" onClick={() => openInExplorer([`ppv${i + 1}`, `vpv${i + 1}`, `ipv${i + 1}`], "today")}>Chart</button>}>
              <div style={{ "--c": PV_COLORS[i] } as never}>
                <div class="stat" style={{ border: 0, padding: 0, background: "none" }}>
                  <div class="v num">{fmtStr(x.p, "W").split(" ")[0]}<span class="u">{fmtStr(x.p, "W").split(" ")[1] ?? ""}</span></div>
                </div>
                <div class="bar" style={{ margin: "6px 0 14px" }}><i style={{ width: `${sh[i] ?? 0}%` }} /></div>
                <div class="list">
                  <div class="li"><span>Voltage</span><span class="num">{fmtStr(x.v, "V")}</span></div>
                  <div class="li"><span>Current</span><span class="num">{fmtStr(x.i, "A")}</span></div>
                  <div class="li"><span>Share of DC input</span><span class="num">{fmtPct(sh[i])}</span></div>
                  <div class="li"><span>Energy today</span><span class="num">{fmtStr(x.e, "kWh")}</span></div>
                  <div class="li"><span>Peak today</span><span class="num">{fmtStr(peaks[i] || null, "W")}</span></div>
                  <div class="li"><span>Peak in range</span><span class="num">{st?.maxAt ? `${fmtStr(st.max, "W")} · ${fmtDateTime(st.maxAt)}` : "—"}</span></div>
                  <div class="li"><span>Lifetime</span><span class="num">{fmtStr(x.tot, "kWh")}</span></div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card title="Tracker comparison" sub={mode === "pct" ? "Each tracker's share of total DC power" : "DC power per tracker"}
        right={<div class="row wrap" style={{ gap: 8 }}>
          <Seg value={range} options={[["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"]]} onChange={setRange} />
          <Seg value={mode} options={[["w", "Power"], ["pct", "Share %"]]} onChange={setMode} />
        </div>}>
        {!hd?.t.length ? <Empty h={300}>{h.loading ? "Loading…" : "No tracker history for this range yet."}</Empty> : (
          <>
            <Chart height={300} x={hd.t} ys={ys} gapSec={hd.tier === 1 ? 180 : 2700} xRange={[from, Math.min(to, now)]}
              axes={[mode === "pct"
                ? { key: "pct", label: "%", side: "left", fmt: (v) => v.toFixed(0), min: 0, max: 100 }
                : { key: "W", label: u.unit, side: "left", fmt: (v) => (v / u.div).toFixed(u.div > 1 ? 1 : 0), min: 0 }]}
              series={[0, 1, 2].map((i) => ({ label: `PV${i + 1}`, color: PV_COLORS[i], axis: mode === "pct" ? "pct" : "W", style: mode === "pct" ? "line" : "line",
                fmt: (v) => (mode === "pct" ? fmtPct(v) : fmtStr(v, "W")) }))} />
            <Legend items={[0, 1, 2].map((i) => ({ label: `PV${i + 1}`, color: PV_COLORS[i] }))} />
          </>
        )}
      </Card>

      <Card title="Daily energy per tracker" sub="From the inverter's per-MPPT day counters">
        {!d14.data?.length ? <Empty h={220}>{d14.loading ? "Loading…" : "No daily summaries yet — they build up from the first day of logging."}</Empty> : (
          <>
            <Chart height={240} xKind="day" x={d14.data.map((d) => ymdToEpoch(d.date))}
              ys={[d14.data.map((d) => d.epv1 / 10), d14.data.map((d) => d.epv2 / 10), d14.data.map((d) => d.epv3 / 10)]}
              axes={[{ key: "kWh", label: "kWh", side: "left", fmt: (v) => v.toFixed(0), min: 0 }]}
              series={[0, 1, 2].map((i) => ({ label: `PV${i + 1}`, color: PV_COLORS[i], axis: "kWh", style: "bars", fmt: (v) => fmtStr(v, "kWh") }))} />
            <div class="scroll-x" style={{ marginTop: 12 }}>
              <table class="t">
                <thead><tr><th>Day</th><th class="r">PV1</th><th class="r">PV2</th><th class="r">PV3</th><th class="r">PV1 share</th></tr></thead>
                <tbody>{d14.data.slice().reverse().slice(0, 7).map((d) => (
                  <tr key={d.date}><td>{fmtDay(ymdToEpoch(d.date) + 43200)}{d.partial ? " (so far)" : ""}</td>
                    <td class="r num">{(d.epv1 / 10).toFixed(1)} kWh</td><td class="r num">{(d.epv2 / 10).toFixed(1)} kWh</td><td class="r num">{(d.epv3 / 10).toFixed(1)} kWh</td>
                    <td class="r num">{fmtPct(d.epv1 + d.epv2 + d.epv3 ? (d.epv1 / (d.epv1 + d.epv2 + d.epv3)) * 100 : null, 0)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      <div class="banner info"><Icon n="info" /><span>Unequal tracker output is normal when strings differ in panel count, orientation or shading. Comparing MPPTs alone can't diagnose a faulty panel without knowing the string layout and conditions.</span></div>
    </>
  );
}
