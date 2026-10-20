# Growatt ShineWiFi-X — original firmware backup

| | |
|---|---|
| Date | 2026-10-20 |
| Device | Growatt ShineWiFi-X, PCB 530.0080300 (2021-11-18), USB bridge Exar XR21V1410 |
| Chip | ESP8266EX, 26 MHz crystal (MAC redacted; shown at `/api/health` on the stick) |
| Flash | 4 MB (JEDEC mfr 0x20, device 0x4016) |
| Inverter | Growatt MIN 8000TL-X |
| File | `shinewifi-x_original_full_4MB.bin` — full 0x000000–0x3FFFFF dump |
| Verification | Read twice; both reads byte-identical. SHA-256 in `SHA256SUMS` |

Contents: Espressif 2nd-stage bootloader v1.6 at 0x0, Growatt firmware up to 0x7FFFF
(talks to `server.growatt.com:5279`), config sector at 0x3F0000.
**This image contains the stick's stored Wi-Fi SSID/password — keep it private** (excluded from git).

## Restore

1. Bridge CN1 GPIO0 ↔ GND and plug the stick into the Mac.
2. From the project root:

```
python3 tools/xr_esptool.py --port /dev/cu.usbmodem214301 --baud 115200 \
  --before no-reset --after no-reset write-flash --flash-size 4MB 0x0 \
  backups/shinewifi-x_original_2026-10-20/shinewifi-x_original_full_4MB.bin
```

Do not go above 115200 baud — the XR21V1410 + macOS AppleUSBACM combination drops out at 460800.
