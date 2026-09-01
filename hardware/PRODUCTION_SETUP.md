# Production hardware connection

The imported files describe Makerfabs ESP32 UWB / DW1000 hardware with
anchors `1782`, `1783`, `1784` and tag short address `007D`.

## Corrected import layout

The imported files originally had names that did not match their contents.
They have been inspected and moved to content-based paths:

- production anchors: `anchor/anchor_1782`, `anchor/anchor_1783`, and
  `anchor/anchor_1784`
- temporary calibration sketch: `calibration/calib_anchor`
- calibration guide: `CALIBRATION.md`
- website-connected production tag: `tag/supalai_tag/supalai_tag.ino`

The authoritative address-to-file table is `MAPPING.md`.

## Database mapping

Set `SEED_DEMO_DATA=false`, `SIMULATOR_ENABLED=false`, and the same
`HARDWARE_INGEST_SECRET` on the FastAPI host before connecting live hardware.

Create three anchors on the selected plan and set `hardware_address` to
`1782`, `1783`, and `1784`. Their `x` and `y` values are surveyed coordinates
in metres; these values are the source of truth for multilateration.

Register `TAG01` in `tags`, assign it to the same project/plan, then register
gateway device `SUPALAI-TAG-GW-01` in `hardware_gateways`.

## Firmware setup

The repository root is a PlatformIO project. Open the repository root in VS
Code (not an individual sketch folder) and install the PlatformIO IDE
extension. The environments are `tag`, `anchor_1782`, `anchor_1783`,
`anchor_1784`, and the temporary `calib_anchor`.

1. Run `powershell -ExecutionPolicy Bypass -File scripts/configure-hardware-secret.ps1 -ApiBaseUrl https://api.example.com`.
   Enter the installation Wi-Fi SSID and password at the secure prompts. The
   script creates the Git-ignored Tag `secrets.h` and uses the same random
   script prints the ignored env file containing `HARDWARE_INGEST_SECRET`;
   copy that value to `backend/.env` or the API host's secret manager.

   For a same-Wi-Fi bench test, expose FastAPI on the LAN and reuse the
   existing Wi-Fi credentials and backend secret:

   `powershell -ExecutionPolicy Bypass -File scripts/configure-hardware-secret.ps1 -ReuseExistingWifi -ApiBaseUrl http://10.10.10.6:8000`

   Start Uvicorn with `--host 0.0.0.0`, not `127.0.0.1`. Replace the sample
   address whenever the PC's Wi-Fi IPv4 address changes. Plain HTTP is for a
   trusted test network only; deploy an HTTPS API URL for field operation.
2. Confirm `TAG_ID`, `GATEWAY_DEVICE_ID`, and the FastAPI URL in the Tag
   sketch.
   Confirm that `tls_root_ca.h` contains the root CA used by that HTTPS host;
   the firmware intentionally refuses insecure TLS.
3. Connect only one ESP32 UWB board, then list serial ports:
   `powershell -ExecutionPolicy Bypass -File scripts/hardware-platformio.ps1 -Action Devices`.
4. Build every firmware environment without touching a board:
   `powershell -ExecutionPolicy Bypass -File scripts/hardware-platformio.ps1 -Action Build -Environment all`.
5. Flash each production anchor to the matching physical board, replacing
   `COM5` with the detected port. For example:
   `powershell -ExecutionPolicy Bypass -File scripts/hardware-platformio.ps1 -Action Upload -Environment anchor_1782 -Port COM5`.
6. Flash the Tag only after `secrets.h` is configured:
   `powershell -ExecutionPolicy Bypass -File scripts/hardware-platformio.ps1 -Action Upload -Environment tag -Port COM5`.
7. Open the 115200 baud serial monitor:
   `powershell -ExecutionPolicy Bypass -File scripts/hardware-platformio.ps1 -Action Monitor -Environment tag -Port COM5`.

The upload command requires an explicit COM port so a different connected
board is not flashed accidentally. The calibration environment also requires
the explicit `-AllowCalibration` switch and must not be used as production
anchor firmware.

The tag groups ranges no older than 1.2 seconds and sends at most four signed
frames per second. FastAPI calculates `(x, y)` in metres, commits the fix to
PostgreSQL with the selected `plan_id`, and its WebSocket updates the live map.
