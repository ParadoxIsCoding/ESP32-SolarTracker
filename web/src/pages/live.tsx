import { efficiency } from "../analytics";
import { Chart, Legend } from "../chart";
import { fmtStr, scaleUnit } from "../format";
import { go, openInExplorer } from "../nav";
import { chanIndex, freshness, useStore, val } from "../state";
import { Card, Empty, Stat } from "../ui";
import { PV_COLORS } from "./overview";

export function LivePage() {
  const s = useStore();
  const b = s.buf;
  const col = (id: string) => b.v[chanIndex(id)] ?? [];
  const online = freshness() !== "offline";
  const powerIds = ["pac", "ppv", "ppv1", "ppv2", "ppv3"];
  const colors = ["#34d399", "#94a3b8", ...PV_COLORS];
  const maxW = Math.max(1, ...powerIds.flatMap((id) => col(id).map((v) => v ?? 0)));
  const u = scaleUnit("W", maxW);
  const enough = b.t.length > 2;

  return (
    <>
      <div class="grid g4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
        <Stat label="AC output" value={val("pac")} unit="W" tone={online ? "acc" : ""} foot={`${s.live ? (s.live.fastMs / 1000).toFixed(0) : "–"} s updates`} onClick={() => openInExplorer(["pac"], "live")} />
        <Stat label="DC input" value={val("ppv")} unit="W" tone="pur" foot={`Loss ${fmtStr(val("ppv") != null && val("pac") != null ? Math.max(0, val("ppv")! - val("pac")!) : null, "W")} (DC − AC)`} onClick={() => openInExplorer(["ppv", "pac"], "live")} />
        <Stat label="Conversion efficiency" value={efficiency(val("pac"), val("ppv"))} unit="%" tone="ok" foot="AC out ÷ DC in (calculated, hidden below 300 W)" onClick={() => go("explorer", { v: "b9" })} />
        <Stat label="Grid voltage" value={val("vac")} unit="V" foot={`${fmtStr(val("iac"), "A")} · ${fmtStr(val("fac"), "Hz")}`} onClick={() => openInExplorer(["vac", "fac"], "live")} />
        <Stat label="Inverter temperature" value={val("tinv")} unit="°C" tone="warn" foot={`IPM ${fmtStr(val("tipm"), "°C")}`} onClick={() => openInExplorer(["tinv", "pac"], "today")} />
      </div>
      <Card title="Live power" sub="Every sample received by this browser in the last 30 minutes">
        {!enough ? <Empty h={320}>{online ? "Collecting samples… the chart fills in as readings arrive." : "Offline — no live readings."}</Empty> : (
          <>
            <Chart height={320} x={b.t} ys={powerIds.map(col)} gapSec={20}
              axes={[{ key: "p", label: u.unit, side: "left", fmt: (v) => (v / u.div).toFixed(u.div > 1 ? 1 : 0), min: 0 }]}
              series={powerIds.map((id, i) => ({ label: s.meta!.channels[chanIndex(id)].name, color: colors[i], axis: "p", width: i < 2 ? 2.2 : 1.6, fmt: (v) => fmtStr(v, "W") }))} />
            <Legend items={powerIds.map((id, i) => ({ label: s.meta!.channels[chanIndex(id)].name, color: colors[i] }))} />
          </>
        )}
      </Card>
      <div class="grid g2">
        <Card title="Grid" sub="Voltage and frequency (live)">
          {!enough ? <Empty h={200}>Waiting for samples…</Empty> : (
            <Chart height={200} x={b.t} ys={[col("vac"), col("fac")]} gapSec={20}
              axes={[{ key: "V", label: "V", side: "left", fmt: (v) => v.toFixed(0) }, { key: "Hz", label: "Hz", side: "right", fmt: (v) => v.toFixed(2) }]}
              series={[{ label: "Voltage", color: "#55c7f7", axis: "V", fmt: (v) => fmtStr(v, "V") }, { label: "Frequency", color: "#a78bfa", axis: "Hz", fmt: (v) => fmtStr(v, "Hz") }]} />
          )}
        </Card>
        <Card title="MPPT voltages" sub="Live DC input voltage per tracker">
          {!enough ? <Empty h={200}>Waiting for samples…</Empty> : (
            <Chart height={200} x={b.t} ys={["vpv1", "vpv2", "vpv3"].map(col)} gapSec={20}
              axes={[{ key: "V", label: "V", side: "left", fmt: (v) => v.toFixed(0), min: 0 }]}
              series={[1, 2, 3].map((n) => ({ label: `PV${n}`, color: PV_COLORS[n - 1], axis: "V", fmt: (v) => fmtStr(v, "V") }))} />
          )}
        </Card>
      </div>
      <p class="foot-note">Live samples are kept only in this browser tab (2-second resolution). The dongle stores 1-minute averages; see the Graph Explorer for history.</p>
    </>
  );
}
