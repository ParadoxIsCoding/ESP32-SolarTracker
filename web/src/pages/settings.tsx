import { useEffect, useState } from "preact/hooks";
import { api, setDemo, type Settings } from "../api";
import { loadPref, savePref } from "../state";
import { Card, Icon, Seg, useAsync } from "../ui";
import { BUILTIN, type RangeKey } from "./explorer";

export function SettingsPage() {
  const cur = useAsync(() => api.settings(), []);
  const [f, setF] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [defRange, setDefRange] = useState<RangeKey>(loadPref("defaultRange", "today"));
  const [defView, setDefView] = useState<string>(loadPref("defaultView", "b1"));
  useEffect(() => { if (cur.data) setF(cur.data); }, [cur.data]);

  const save = async () => {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      setF(await api.saveSettings(f));
      setMsg({ ok: true, text: "Saved on the dongle." });
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    }
    setBusy(false);
  };
  const num = (k: keyof Settings, v: string) => f && setF({ ...f, [k]: Number(v) });
  const views = loadPref<{ id: string; name: string }[]>("views", []);

  return (
    <>
      <div class="grid g2">
        <Card title="Dongle settings" sub="Stored on the ShineWiFi-X. Saving asks for the firmware-update credentials.">
          {!f ? <div class="faint">{cur.loading ? "Loading…" : cur.err}</div> : (
            <div class="grid" style={{ gap: 14 }}>
              <label class="f">Inverter name<input class="input" maxLength={40} value={f.name} onInput={(e) => setF({ ...f, name: (e.target as HTMLInputElement).value })} /></label>
              <div class="grid g2" style={{ gap: 12 }}>
                <label class="f">Live polling (ms)<input class="input num" type="number" min={1000} max={10000} step={500} value={f.fastMs} onInput={(e) => num("fastMs", (e.target as HTMLInputElement).value)} /></label>
                <label class="f">Counters &amp; diagnostics (ms)<input class="input num" type="number" min={5000} max={60000} step={1000} value={f.slowMs} onInput={(e) => num("slowMs", (e.target as HTMLInputElement).value)} /></label>
              </div>
              <p class="foot-note" style={{ margin: 0 }}>Default 2 s / 10 s. Each poll keeps the inverter's serial link busy for about 50–90 ms, so 2 s leaves it more than 95% idle. Below 1 s isn't allowed: the inverter updates most values only about once a second.</p>
              <div class="grid g2" style={{ gap: 12 }}>
                <label class="f">Usage rate ($/kWh)<input class="input num" type="number" min={0} max={5} step={0.00001} value={f.tariffImport} onInput={(e) => num("tariffImport", (e.target as HTMLInputElement).value)} /></label>
                <label class="f">Daily supply ($/day)<input class="input num" type="number" min={0} max={20} step={0.00001} value={f.supplyPerDay} onInput={(e) => num("supplyPerDay", (e.target as HTMLInputElement).value)} /></label>
                <label class="f">Feed-in, first tier ($/kWh)<input class="input num" type="number" min={0} max={5} step={0.001} value={f.tariffExport} onInput={(e) => num("tariffExport", (e.target as HTMLInputElement).value)} /></label>
                <label class="f">Feed-in, second tier ($/kWh)<input class="input num" type="number" min={0} max={5} step={0.001} value={f.tariffExport2} onInput={(e) => num("tariffExport2", (e.target as HTMLInputElement).value)} /></label>
                <label class="f">First tier applies to (kWh per day)<input class="input num" type="number" min={0} max={200} step={0.5} value={f.exportTier1Kwh} onInput={(e) => num("exportTier1Kwh", (e.target as HTMLInputElement).value)} /></label>
              </div>
              <p class="foot-note" style={{ margin: 0 }}>Set the tier threshold to 0 for a single feed-in rate. Check your plan's fact sheet for how many kWh per day earn the higher rate.</p>
              <label class="f">Grid emissions factor (kg CO₂-e per kWh)<input class="input num" type="number" min={0} max={2} step={0.01} value={f.co2PerKwh} onInput={(e) => num("co2PerKwh", (e.target as HTMLInputElement).value)} /></label>
              <div class="row" style={{ gap: 10 }}>
                <button class="btn pri" onClick={save} disabled={busy}><Icon n="save" size={15} />{busy ? "Saving…" : "Save to dongle"}</button>
                {msg && <span class="small" style={{ color: msg.ok ? "var(--ok)" : "var(--err)" }}>{msg.text}</span>}
              </div>
            </div>
          )}
        </Card>

        <Card title="This browser" sub="Preferences stored only on this device">
          <div class="grid" style={{ gap: 14 }}>
            <label class="f">Graph Explorer opens with
              <select class="input" value={defView} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setDefView(v); savePref("defaultView", v); }}>
                <optgroup label="Saved views">{views.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</optgroup>
                <optgroup label="Presets">{BUILTIN.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</optgroup>
              </select>
            </label>
            <div class="f"><span>Default chart range</span>
              <Seg value={defRange} options={[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]]} onChange={(v) => { setDefRange(v); savePref("defaultRange", v); }} />
            </div>
            <div class="f"><span>Demo mode</span>
              <div class="row" style={{ gap: 8 }}>
                <button class="btn" onClick={() => setDemo(!api.demo)}>{api.demo ? "Exit demo mode" : "Preview with synthetic data"}</button>
                <span class="small faint">Clearly labelled; never mixed with real readings.</span>
              </div>
            </div>
            <button class="btn ghost" style={{ alignSelf: "flex-start" }} onClick={() => { if (confirm("Reset saved views, favourites and layout on this browser?")) { Object.keys(localStorage).filter((k) => k.startsWith("solar.")).forEach((k) => localStorage.removeItem(k)); location.reload(); } }}>Reset browser preferences</button>
          </div>
        </Card>
      </div>

      <div class="grid g2">
        <Card title="Data retention" sub="Fixed by the 2 MB history partition">
          <div class="list">
            <div class="li"><span>1-minute averages</span><span>≈ 18 days (16 in summer, 20 in winter)</span></div>
            <div class="li"><span>15-minute averages</span><span>≈ 4 months</span></div>
            <div class="li"><span>Daily summaries</span><span>≈ 22 years (generation, export, grid import, peaks)</span></div>
            <div class="li"><span>Live 2-second samples</span><span>This browser tab only (30 min)</span></div>
          </div>
          <p class="foot-note" style={{ marginBottom: 0 }}>Download history files from Diagnostics → Backup to keep them longer.</p>
        </Card>
        <Card title="Firmware & security">
          <div class="list">
            <div class="li"><span>Update firmware over Wi-Fi</span><a href="/update">Open updater</a></div>
            <div class="li"><span>Inverter control</span><span class="q-verified">Disabled — read-only build</span></div>
            <div class="li"><span>Wi-Fi network</span><span class="small muted">Hold the stick's button ~3 s to open the GrowattConfig setup network</span></div>
          </div>
          <p class="foot-note" style={{ marginBottom: 0 }}>Keep the dongle on your home network only — don't port-forward it to the internet. Changing settings, rebooting and firmware updates need the credentials in Secrets.h.</p>
        </Card>
      </div>
    </>
  );
}
