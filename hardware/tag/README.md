# Tag firmware — not yet implemented

This folder is a placeholder — same situation as `hardware/anchor/`.
A UWB tag worn by a sales rep needs to range against nearby anchors and
report those distances somewhere the backend can read them; the exact
firmware depends on the chip/board chosen, which this project doesn't
currently specify.

Until real hardware exists, `backend/backend/simulator.py` moves the
seeded demo tags around the floor plan so the app has live data to
show. See `backend/README.md` → "Connecting real UWB hardware" for how
a real tag would plug in via `POST /api/positioning/{project_id}/ingest`.
