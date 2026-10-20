# Stick HTTP API

The ShineWiFi-X serves everything on port 80 of its LAN address. All `GET` endpoints are read-only and unauthenticated (LAN only — never expose the stick to the internet). State-changing endpoints use HTTP basic auth with `OTA_HTTP_USER` / `OTA_HTTP_PASSWORD` from `Secrets.h`.

There is **no endpoint that writes to the inverter**. The firmware is built with `INVERTER_READ_ONLY`, and the binary contains no Modbus write functions.

Times are UTC epoch seconds. Day boundaries and `YYYYMMDD` dates are Australia/Brisbane (UTC+10, no DST).

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Dashboard (gzip, `ETag`). |
| GET | `/api/meta` | Measurement catalogue and history tier layout. |
| GET | `/api/live` | Latest value of every catalogue channel. |
| GET | `/api/series` | History stream (binary). |
| GET | `/api/days` | Daily summaries. |
| GET | `/api/device` | Inverter identity, clock and drift, grid protection settings (raw). |
| GET | `/api/registers` | Raw cache: input 3000–3124 and holding 0–124 from the last polls. |
| GET | `/api/health` | Stick, Modbus link, memory and storage health. |
| GET | `/api/events` | Event log. |
| GET | `/api/files` | History files (for backup). |
| GET | `/api/file?path=` | Download one history file (`/h1/`, `/h15/`, `/d/` only). |
| GET | `/api/raw?fn=&start=&count=` | Live read of a whitelisted, documented register window (fn 4: 0–124, 3000–3124; fn 3: 0–124; count ≤ 45). |
| GET | `/api/settings` | Settings. |
| POST | `/api/settings` | **auth** · JSON body with any of the settings fields. |
| GET | `/update` | **auth** · upload form. |
| POST | `/update` | **auth** · firmware upload (`multipart/form-data`, field `firmware`). Buffered history is saved before writing; filesystem images are refused (they would erase history). |
| GET | `/reboot`, `/startAp` | **auth** · reboot / open the Wi-Fi setup access point. |

## `/api/meta`

```json
{
  "categories": [{"id": "solar", "name": "Solar generation"}, ...],
  "channels": [{"id": "pac", "name": "AC output power", "unit": "W", "cat": "solar",
                "reg": 3023, "type": "s32", "scale": 0.1, "kind": "power",
                "quality": "verified", "desc": "..."}, ...],
  "tiers": {
    "h1":  {"interval": 60,  "channels": ["pac", "ppv", ...],               "scale": [1, 1, ...]},
    "h15": {"interval": 900, "channels": ["pac:mean", ..., "pac:max", "eac_today:last", ...], "scale": [...]}
  }
}
```

* `type`: `u16 s16 u32 s32 lo8 hi8`. Value = raw × `scale`. 32-bit values span `reg` and `reg+1`, high word first.
* `kind`: `power`, `instant`, `counter_day` (resets daily), `counter_total`, `code`, `status`.
* `quality`: `verified`, `documented`, `unverified`.

## `/api/live`

```json
{"t": 1792480899, "now": 1792480900, "ageMs": 1608, "slowAgeMs": 6200, "link": true,
 "fastMs": 2000, "time": "ntp", "v": [1, 0, 222.3, ...]}
```

`v[i]` belongs to `channels[i]`. It's `null` when the value is unavailable (no link, or slow-block data older than 3 × `slowMs`). `t` is the time of the last successful poll. `time` is `ntp`, `inverter` (corrected fallback) or `none`.

## `/api/series?tier=1|15&from=&to=&cols=`

`cols` is a comma-separated list of column codes: `channelIndex | (agg << 6)`, with agg `0` = mean, `1` = max, `2` = last. The available (channel, agg) pairs per tier are listed in `meta.tiers`. Spans are clamped to 32 days (tier 1) and 400 days (tier 15).

The response is `application/octet-stream`, little-endian:

```
"SER1"  u8 ncols  u8 tier  u16 rowBytes
rows:   u32 ts  then ncols × i16    (INT16_MIN = missing)
```

Value = stored i16 × the tier's `scale` for that column. Timestamps are the start of the minute or quarter-hour. There are no rows for periods without data (gaps are real).

## `/api/days?from=YYYYMMDD&to=YYYYMMDD`

```json
{"cols": ["date","eac","epv1","epv2","epv3","eacTotalFirst","eacTotalLast","eimp","eexp","eload",
          "pacPeak","pacPeakMin","ppv1Peak","ppv2Peak","ppv3Peak","tinvMax","vacMin","vacMax",
          "facMin","facMax","firstGenMin","lastGenMin","onlineMin","genMin","fault","warn","flags","partial"],
 "rows": [[20261020, 440, 289, 180, 0, 575400, 575402, ...], ...]}
```

Units:

* Energies: 0.1 kWh. `eac` is the inverter's own day counter (its last value that day).
* Power: W. Temperature: 0.1 °C. Voltage: 0.1 V. Frequency: 0.01 Hz.
* `*Min`: minute of the day (65535 = none).
* `tinvMax`: −32768 = none.
* `flags`: bit 0 = the day counter dropped after generation started (larger value kept); bit 1 = the lifetime counter went backwards (ignored).
* `partial = 1`: today, in progress.

## Settings

```json
{"name": "Growatt MIN 8000TL-X", "fastMs": 2000, "slowMs": 10000,
 "tariffImport": 0.27974, "tariffExport": 0.08, "tariffExport2": 0.03, "exportTier1Kwh": 8,
 "supplyPerDay": 1.92015, "co2PerKwh": 0.73}
```

| Field | Allowed range |
|---|---|
| `fastMs` | 1000–10000 |
| `slowMs` | 5000–60000, and ≥ `fastMs` |
| tariffs | 0–5 $/kWh |
| `exportTier1Kwh` | 0–200 (0 = single feed-in rate) |
| `supplyPerDay` | 0–20 $ |
| `name` | 1–40 characters |

Settings are written atomically (temp file + rename).

## Storage format (LittleFS)

| File | Contents |
|---|---|
| `/h1/DDDDD.bin` | One file per Brisbane day (days since 1970-01-01), 1-minute records. |
| `/h15/YYYYMM.bin` | One file per month, 15-minute records. |
| `/d/YYYY.bin` | 64-byte daily summaries (layout in `SolarCore.cpp` `packDay`). |
| `/d/today.bin` | Checkpoint of the day in progress (saved every 15 min and at dusk). |
| `/ev.bin`, `/ev.old` | 12-byte events: `u32 ts, u8 type, u8 0, u16 code, u32 value`. |
| `/cfg/settings.json`, `/cfg/clock.json` | Settings; measured inverter-clock offset. |

History file header: `"GSH" u8 version, u8 tier, u8 ncols, u16 recordBytes, ncols × u8 column code`.

Record: `u32 ts, u8 samples, u8 flags, ncols × i16, u16 CRC-16/CCITT-FALSE` over the preceding bytes. Records with a bad CRC (e.g. torn by power loss) are skipped when read. When a tier exceeds its budget, its oldest files are deleted (736 / 448 / 512 KiB), like a rolling camera recording. As a second guard, at least 128 KiB of the filesystem is always kept free: if that is undercut, the oldest 1-minute days and then 15-minute months are removed. Daily summaries are never removed by this guard.

Event types: 1 boot, 2 NTP sync, 3 link up, 4 link down, 5 status change (code = new, value = old), 6 fault code change, 7 warning code change, 8 counter anomaly, 9 day closed (value = YYYYMMDD), 10 settings changed, 11 storage (code 1 = tier budget delete, code 2 = write failure, code 3 = free-space guard delete; value = bytes).
