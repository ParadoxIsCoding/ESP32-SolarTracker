# Standalone ESP8266 budget — Growatt ShineWiFi-X (ESP8266EX, 4 MB)

Measured 2026-10-20 from real builds (`pio run -e ShineWifiX-MinTLX`) and real library sizes.

## Flash layout (`eagle.flash.4m2m.ld`)

| Region | Range | Size | Use |
|---|---|---|---|
| Sketch + OTA staging | 0x000000–0x1FFFFF | 2048 KiB | running image (max 1020 KiB) + room for a new image during OTA |
| LittleFS | 0x200000–0x3F9FFF | 2024 KiB (253 × 8 KiB blocks) | history, daily summaries, settings, presets |
| SDK / RF cal / Wi-Fi | 0x3FA000–0x3FFFFF | 24 KiB | Espressif system data |

`4m3m` would give 3 MB of history but leaves no space for OTA (the image would have to be under ~500 KiB, and it already exceeds that). `4m2m` is the largest filesystem that keeps OTA.

## Firmware image

| | Bytes | % of 1020 KiB max |
|---|---|---|
| Stock OIG (ShineWifiX, MQTT on) | 478,983 | 45.9 % |
| **Stage 1 read-only probe (measured)** | **477,063** | **45.7 %** |
| + history engine, catalogue, API (est.) | +25–35 KiB | |
| + dashboard, gzipped in PROGMEM (est.) | +60–70 KiB | |
| **Projected final image** | **~570 KiB** | **~56 %** |

OTA needs free sketch space ≥ new image size: about 1.45 MiB free versus a ~570 KiB image, so OTA works.

### Frontend (measured, gzip -9)

| Library | Minified | Gzipped |
|---|---|---|
| uPlot 1.6.31 (JS + CSS) | 52.2 KiB | 22.0 KiB |
| Preact 10.24 + hooks | 15.2 KiB | 6.1 KiB |
| App code + CSS (est.) | ~110 KiB | ~30–40 KiB |

There are no CDN dependencies. Everything is served from flash with `Content-Encoding: gzip`, and charts render in the browser.

## RAM (80 KiB DRAM)

| | Bytes |
|---|---|
| Static RAM (data+bss), stage 1 measured | 43,276 |
| Left for heap at boot | ~38,600 |
| Wi-Fi stack + TCP once connected (typical) | −10,000 to −14,000 |
| **Expected free heap, stage 1** | **~24–28 KiB** (measured live at `/api/health`) |
| History accumulators + 5-min write buffer | ~1.0 KiB |
| LittleFS caches (page 256 B) + one open file | ~1.5 KiB |
| HTTP chunked streaming buffer | ~1.0 KiB transient |
| **Target headroom after stage 2** | **≥ 15 KiB free, largest block ≥ 8 KiB** |

## History capacity (LittleFS, plan ~85 % = 1,720 KiB)

The record is 4 B timestamp + 24 channels × int16 + 4 B flags/CRC = 56 B. The inverter is only powered in daylight: Brisbane gives about 11 h in June, 12.5 h average and 14 h in December.

| Tier | Contents | Allocation | Retention |
|---|---|---|---|
| 1-minute | mean of the 10-s polls, every channel | 1,088 KiB | **~26 days** (24 in Dec, 30 in Jun) |
| 15-minute | mean + min/max of power, every channel | 448 KiB | **~4.7 months** |
| Daily summary | 48 B: inverter day/lifetime counters, per-MPPT kWh, peaks + times, min/max V/f/temp, online/generating minutes, fault/warn codes | 176 KiB | **~10 years** |
| Settings/presets | small JSON | ~8 KiB | |

Each tier is a ring of fixed-size segment files; the oldest segment is deleted when space is needed.

### Wear and power-loss safety
- Records are buffered in RAM and appended every 5 minutes. They are also flushed immediately when the inverter goes into "waiting" at dusk. That is about 164 appends/day, ≈ 490 block erases/day spread over 253 blocks, which is about 140 years to the 100k-cycle rating.
- LittleFS is copy-on-write and power-loss safe at the metadata level. Every record also carries a CRC, so a torn final record is detected and skipped on reload.
- Daily summaries and settings are written to a temp file and then `rename()`d, which is atomic.
- Worst-case loss on sudden power-off is ≤ 5 minutes of 1-minute detail. Energy totals are never lost, because they come from the inverter's own counters.

## Constraints and the compromise chosen

| Requirement | Constraint | Compromise |
|---|---|---|
| Dashboard always available | The stick is powered by the inverter's USB port; a MIN TL-X normally powers down at night | History is preserved and logging resumes each morning. **The dashboard is unreachable while the inverter is off.** (Optional fix: a USB power injector that blocks back-feed into the inverter port. Not part of this build.) |
| Raw readings 90 days, 1-minute data 1 year, 15-minute forever | 2 MB of history flash | 1-minute data ~26 days, 15-minute ~4.7 months, daily ~10 years |
| 10-second stored history | Same | 10-second data only in the browser while a page is open; 1-minute is the finest stored resolution |
| Concurrent clients / large downloads | ESP8266WebServer serves one request at a time | History is served per channel and per day in chunks; long ranges automatically use the 15-minute/daily tiers |
| Export SVG | uPlot draws to canvas | PNG + CSV export; no SVG |
| Inter font | ~50–100 KiB of flash | System UI font (SF Pro on Mac/iPhone) with tabular numerals |
| Correct timestamps | Needs NTP; the inverter clock is never written (read-only) | NTP for the ESP clock; the inverter RTC (holding regs 45–50, read-only) as fallback and shown as drift on Diagnostics; no records written until time is valid |
