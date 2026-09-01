# Anchor firmware

The Makerfabs ESP32 UWB / DW1000 production sketches are organized by short
address in `anchor_1782`, `anchor_1783`, and `anchor_1784`. Read
`hardware/MAPPING.md` before flashing a board.

Create corresponding anchors in Plan Editor and set their UWB hardware
addresses to `1782`, `1783`, and `1784`. Surveyed `(x, y)` coordinates are
metres and are the source of truth used by multilateration.
