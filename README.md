# ESP32-SolarTracker — standalone Growatt solar analytics

A self-contained monitoring dashboard for a **Growatt MIN 8000TL-X** that runs entirely on the inverter's own **ShineWiFi-X** Wi-Fi stick (ESP8266EX, 4 MB flash). There's no cloud, server or app: open the stick's IP address in a browser on your home network.

* **Firmware:** [OpenInverterGateway](https://github.com/OpenInverterGateway/OpenInverterGateway), adapted into a **read-only** build. The compiled binary contains no Modbus write functions at all.
* **Polling:** power, PV and AC values every 2 s; energy counters and diagnostics every 10 s, with automatic back-off when the inverter shuts down.
* **History** is kept in the stick's flash (LittleFS, 2 MB):
  * 1-minute averages for ~18 days
  * 15-minute averages for ~4 months
  * daily summaries (generation, export, grid import, peaks) for ~22 years
* **Dashboard:** Preact + uPlot, about 67 KB gzipped and served from flash. It has Overview, Live, Graph Explorer, MPPT, Energy, All measurements, Diagnostics and Settings pages.

> The stick is powered by the inverter, so the dashboard is unreachable at night. History is preserved and logging resumes when the inverter wakes up.

## Layout

| Path | What |
|---|---|
| `catalog/catalog.json` | **Single source of truth** for every measurement (register, type, scale, unit, quality). |
| `tools/gen_catalog.py` | Generates `Catalog.gen.h` (firmware) and `web/src/catalog.gen.json` from the catalogue. |
| `firmware/OpenInverterGateway/` | Vendored OIG (upstream commit in `UPSTREAM_COMMIT`) plus the standalone runtime. |
| `…/SRC/ShineWiFi-ModBus/SolarCore.*` | Portable core: time maths, decoding, aggregation, record format, daily summaries. |
| `…/SRC/ShineWiFi-ModBus/SolarStore.*` | LittleFS persistence: tier files, ring retention, event log, atomic writes. |
| `…/SRC/ShineWiFi-ModBus/LocalApi.*` | Poller, aggregation scheduling and the HTTP API. |
| `firmware/test/host/` | Host (Mac) unit tests for `SolarCore`. |
| `web/` | Dashboard source (TypeScript + Preact + uPlot), build and dev server. |
| `tools/xr_esptool.py` | esptool wrapper for the stick's XR21V1410 USB bridge on macOS. |
| `tools/dump_registers.py` | Saves a read-only dump of every whitelisted register window. |
| `docs/` | Budget, measurement report, API reference, register dumps. |
| `backups/` | Original Growatt firmware (git-ignored: it contains Wi-Fi credentials). |

## Build

Requirements: Python 3 with `platformio`, `esptool` and `pyusb`; Homebrew `libusb`; Node.js ≥ 22; Rosetta 2 on Apple Silicon (the ESP8266 toolchain is x86_64-only).

```bash
cp firmware/OpenInverterGateway/SRC/ShineWiFi-ModBus/Secrets.h.example firmware/OpenInverterGateway/SRC/ShineWiFi-ModBus/Secrets.h   # set an update password
python3 tools/gen_catalog.py              # after editing catalog/catalog.json
cd web && npm install && npm run build    # builds the dashboard and embeds it in the firmware
cd ../firmware/OpenInverterGateway && pio run -e ShineWifiX-MinTLX
```

Tests:

```bash
make -C firmware/test/host                # 52 firmware core checks
cd web && npm test && npm run typecheck   # dashboard calculations
```

## Flashing

**Over Wi-Fi** (normal): open `http://<stick-ip>/update` and upload `firmware/OpenInverterGateway/.pio/build/ShineWifiX-MinTLX/firmware.bin`, or:

```bash
curl -u admin:<password> -F "firmware=@firmware/OpenInverterGateway/.pio/build/ShineWifiX-MinTLX/firmware.bin" http://<stick-ip>/update
```

History and settings survive updates: buffered minutes are written to flash as soon as an authenticated upload starts. Filesystem images are refused, because they would erase history.

**Over USB** (first install or recovery): open the stick and bridge CN1 pin 6 (GPIO0) to pin 7 (GND) while plugging it into the Mac. Then:

```bash
python3 tools/xr_esptool.py --port /dev/cu.usbmodem214301 --baud 115200 --before no-reset --after no-reset write-flash --flash-size 4MB 0x0 firmware/OpenInverterGateway/.pio/build/ShineWifiX-MinTLX/firmware.bin
```

Use only 115200 baud. The XR21V1410 + macOS combination drops out at higher rates. To restore the original Growatt firmware, see `backups/*/README.md`.

## Wi-Fi setup

With no saved network, the stick opens the `GrowattConfig` access point (password `growsolar`). Hold the stick's button for about 3 s to reopen it later. Pick your 2.4 GHz network there. The setup page deliberately has no firmware-upload option: its password is a public default, so firmware can only be installed through the authenticated `/update` or over USB.

## Development

```bash
DEVICE=192.168.86.29 node web/dev.mjs     # serves web/dist, proxies /api to the stick
```

Add `?demo` to the URL for clearly-labelled synthetic data.

## Data accuracy

* Every measurement has a quality level:
  * **verified:** cross-checked against this inverter on 2026-10-20
  * **documented:** a documented register with a plausible value
  * **unverified:** e.g. the grid-meter registers, whose power balance doesn't close
* Missing data is shown as "—" and gaps are never filled. Calculated values are labelled.
* Daily energy comes from the inverter's own counters, not from integrating power.
* Times are Australia/Brisbane (UTC+10). Timestamps come from NTP. The inverter clock (62 min slow at install) is only used with a measured correction and is never written.

See [docs/MEASUREMENT_REPORT.md](docs/MEASUREMENT_REPORT.md), [docs/ESP8266_BUDGET.md](docs/ESP8266_BUDGET.md) and [docs/API.md](docs/API.md).
