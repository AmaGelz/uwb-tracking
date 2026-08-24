# Anchor firmware — not yet implemented

This folder is a placeholder. Writing real anchor firmware needs
specifics this project doesn't currently pin down: which UWB chip
(e.g. Decawave/Qorvo DW1000 or DW3000), which MCU/dev board, and which
ranging protocol (raw TWR, or a vendor stack like Qorvo's).

Until real hardware is chosen, the backend fills this gap with:

- `backend/backend/simulator.py` — generates realistic live tag
  movement so the rest of the app (live map, visits, analytics) has
  real data to work with.
- `POST /api/positioning/{project_id}/ingest` — the real integration
  point once hardware exists. It expects each anchor to report a
  measured distance (via two-way ranging) to a tag; the backend solves
  the (x, y) position via least-squares multilateration
  (`backend/backend/positioning.py`). Anchor firmware's job is to
  produce those distances and get them to this endpoint (directly, or
  via a gateway) — no other backend changes should be needed.

See the root `README.md` and `backend/README.md` ("Connecting real UWB
hardware") for more.
