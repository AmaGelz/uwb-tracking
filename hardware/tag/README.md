# Tag firmware

Production firmware for the Makerfabs ESP32 UWB / DW1000 tag is in
`supalai_tag/supalai_tag.ino`. It collects fresh ranges from at least three
anchors and sends an HMAC-signed frame to FastAPI's
`POST /api/hardware/ingest` endpoint every 250 ms.

Use HTTPS for deployed hardware. Plain HTTP is available only for testing on
a trusted local network where the ESP32 connects directly to the developer's
FastAPI server.

Copy `secrets.example.h` to the Git-ignored `secrets.h`, or run
`scripts/configure-hardware-secret.ps1`. Never put `DATABASE_URL` or a
PostgreSQL password on the ESP32. See `hardware/PRODUCTION_SETUP.md` for the
complete setup.
