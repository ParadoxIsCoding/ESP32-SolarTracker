# Measurement availability report — Growatt MIN 8000TL-X

Established on 2026-10-20 (≈16:40 AEST, ~1.1 kW output) from real read-only Modbus responses over the ShineWiFi-X USB link (`/api/raw`, function codes 3 and 4 only). Raw dumps are in `docs/register-dumps/`.

## Identity (holding registers, read only)

| Item | Register | Value | Check |
|---|---|---|---|
| Serial number | H23–27 (ASCII) | redacted | **Matches the nameplate** |
| Device type | H34–41 (ASCII) | `PV Inverter` | |
| Device type code (DTC) | H43 | 5201 | |
| Trackers / phases | H44 | `0x0201` → 2 trackers, 1 phase | Nameplate lists 3 inputs; see PV3 below |
| Firmware / control FW | H9–11 / H12–14 | `AM1.0` / `ZABA` (+ `AMAA02010008` at H82–87) | |
| Modbus version | H88 | 305 | |
| Active power rate | H3 | 100 % | No curtailment configured |
| Grid protection | H52–63 | V< 180.0 V, V> 265.0 V, F< 47.00 Hz, F> 52.00 Hz (plus further stages) | AS/NZS 4777-style values |
| Inverter RTC | H45–50 | 2026-10-20 15:38:04 | **62 min behind NTP**; never written (read-only) |

## Register blocks

Both documented input blocks answer, in about 24 ms per 45-register read:

* **0–124** (legacy v1.20/1.24 layout) — mirrors most values but **reads PV3 as zero**.
* **3000–3124** (v1.24 TL-X layout) — **the primary source.** It is a superset: it adds PV3, reactive power, meter data, insulation resistance, communication-board temperature and fault/warning codes.

### Internal consistency checks (one snapshot)

| Check | Result |
|---|---|
| Ppv (3001) = PV1 + PV2 + PV3 power | 1165.6 = 971.1 + 193.4 + 1.1 W ✔ exact |
| PV energy total (3053) = PV1 total + PV2 total | 61 368.5 = 27 095.0 + 34 273.5 kWh ✔ exact |
| PV energy today (3083) = PV1 + PV2 today | 46.6 = 28.8 + 17.8 kWh ✔ exact |
| AC today (3049) vs PV today | 43.8 / 46.6 kWh → 94 % conversion ✔ plausible |
| Legacy block vs 3000 block | Pac, Fac, Vac, energies, temperatures agree within one sample ✔ |
| Real output % (3101) | 13 % vs 1089.8 W / 8000 W = 13.6 % ✔ |

## Verified measurements (3000 block unless noted)

| Group | Measurement | Reg | Type | Scale | Sample |
|---|---|---|---|---|---|
| Status | Inverter status (low byte) / run state (high byte) | 3000 | u16 | — | 1 = Normal |
| Solar | Total PV input power | 3001 | u32 | 0.1 W | 1165.6 W |
| MPPT 1 | Voltage / current / power | 3003 / 3004 / 3005 | u16 / u16 / u32 | 0.1 V / 0.1 A / 0.1 W | 285.0 V / 3.4 A / 971.1 W |
| MPPT 2 | Voltage / current / power | 3007 / 3008 / 3009 | u16 / u16 / u32 | same | 281.4 V / 0.6 A / 193.4 W |
| MPPT 3 | Voltage / current / power | 3011 / 3012 / 3013 | u16 / u16 / u32 | same | 7.2 V / 0.1 A / 1.1 W |
| AC | Output (active) power | 3023 | s32 | 0.1 W | 1089.8 W |
| AC | Reactive power | 3021 | s32 | 0.1 var | 0 |
| AC | Apparent power (L1) | 3028 | u32 | 0.1 VA | 1089.9 VA |
| AC | Grid voltage / current | 3026 / 3027 | u16 | 0.1 V / 0.1 A | 241.0 V / 4.5 A |
| AC | Grid frequency | 3025 | u16 | 0.01 Hz | 49.95 Hz |
| AC | Power factor | 3100 | u16 | raw 0–20000 | 20000 (unity) |
| AC | Real output percent | 3101 | s16 | % | 13 |
| Energy | AC energy today / lifetime | 3049 / 3051 | u32 | 0.1 kWh | 43.8 / 57 540.0 kWh |
| Energy | PV energy today / lifetime | 3083 / 3053 | u32 | 0.1 kWh | 46.6 / 61 368.5 kWh |
| Energy | PV1 / PV2 / PV3 today | 3055 / 3059 / 3063 | u32 | 0.1 kWh | 28.8 / 17.8 / 0.0 |
| Energy | PV1 / PV2 / PV3 lifetime | 3057 / 3061 / 3065 | u32 | 0.1 kWh | 27 095.0 / 34 273.5 / 0.0 |
| Runtime | Total working time | 3047 | u32 | 0.5 s | 18 443 h |
| Diagnostics | Inverter / IPM / boost temperature | 3093 / 3094 / 3095 | u16 | 0.1 °C | 34.4 / 34.4 / 0.0 |
| Diagnostics | Communication board temperature | 3097 | u16 | 0.1 °C | 36.3 |
| Diagnostics | P-bus voltage | 3098 | u16 | 0.1 V | 368.8 V |
| Diagnostics | PV insulation resistance | 3087 | u16 | kΩ (per OIG) | 1324 |
| Diagnostics | Derating mode | 3086 | u16 | code | 14 (meaning not documented → shown as raw code) |
| Diagnostics | Fault / warning main code | 3105 / 3106 | u16 | code | 0 / 0 |
| Diagnostics | DCI R / GFCI current | 3088 / 3091 | u16 | 0.1 mA / mA | 0 / 0 |
| Diagnostics | Start delay | 3115 | u16 | s | 65 |

## PV3 / MPPT 3
The PV3 input reads a steady **7.1–7.2 V, 0.1 A and ~1 W** across 6 samples, with **0.0 kWh lifetime energy**. Holding register 44 reports 2 configured trackers. **Conclusion: no string is connected to MPPT 3** (the small voltage is residual/leakage). The dashboard shows PV3 as present but "no string detected", rather than hiding it or treating it as a fault. Please confirm how many strings are wired.

## Grid meter registers — present but unverified
The meter registers change independently of inverter output, so an export-limiting meter is very likely wired to the inverter:

| Measurement | Reg | Sample |
|---|---|---|
| Grid import power (forward) | 3041 (s32, 0.1 W) | 0 W |
| Grid export power (reverse) | 3043 (s32, 0.1 W) | 506–626 W |
| Load power | 3045 (s32, 0.1 W) | 327–512 W |
| Self-use power | 3121 (u32, 0.1 W) | 352–404 W |
| Import energy today / total | 3067 / 3069 | 0.4 / 6 601.3 kWh |
| Export energy today / total | 3071 / 3073 | 31.7 / 39 991.7 kWh |
| Load energy today / total | 3075 / 3077 | 15.3 / 27 978.1 kWh |

The power balance `load = output + import − export` does **not** close: load reads 40–100 W higher in every sample. The energy totals don't balance either, because the inverter (and so the meter registers) is unpowered at night and can't count night-time import. These values are labelled **"meter-derived · unverified"**, kept in their own category, and never used for financial "savings" figures until you confirm the meter and compare it with your utility meter.

## Not available / not applicable
* Battery and BDC registers (3125–3184) — no battery; not polled and not shown.
* PV4–PV8, phases L2/L3, line-to-line voltages — always 0 on this single-phase inverter; not shown.
* Inverter fault history — not exposed in the documented read-only blocks.
* Night-time data — the inverter (and the stick) are unpowered at night.
