# SUPALAI-UWB Backend

FastAPI backend for the SUPALAI Tracking dashboard. Talks directly to
Postgres (a Supabase project, or any Postgres) — no SQLite involved.

## 1. Install

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 2. Point it at a database

You need a **Postgres connection string**, not just the Supabase
project's URL/anon key (those are for the REST/PostgREST API — see
`supabase_main.py` for that path — and can't open a raw SQL connection
on their own).

Get it from **Supabase dashboard → Project Settings → Database →
Connection string → URI**. Use the "Transaction pooler" URI (port
`6543`) — it plays nicely with the connection pool this backend keeps
open.

Put it in `backend/.env`:

```env
DATABASE_URL=postgresql://postgres.xxxxx:[YOUR-PASSWORD]@aws-0-REGION.pooler.supabase.com:6543/postgres
```

Then create the schema (and load demo data):

```bash
cd ..   # repo root
python migration/migration.py --seed
```

`migration/migration.py` is idempotent — safe to run again later after
pulling schema changes. See `--help` for options, including
`--from-sqlite` if you have a prior SQLite deployment to bring over.

**No Supabase project yet / just want to try it locally?** Leave
`DATABASE_URL` empty in `backend/.env`. The backend falls back to
`postgresql://postgres:postgres@127.0.0.1:5432/supalai_test` and will
create its own schema + seed data on first boot, as long as a local
Postgres is reachable there.

## 3. Start the server

```bash
cd backend/backend
python main.py
```

or

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

On startup it applies `database/schema.sql`, loads
`database/seed.sql`, and — unless `SIMULATOR_ENABLED=false` — starts a
background task that moves the demo tags around the seeded floor plan
so the live map, visit history, and analytics all have real (if
synthetic) data without any physical UWB hardware attached.

## 4. Try it

- http://127.0.0.1:8000/ — the frontend (served directly by this backend)
- http://127.0.0.1:8000/docs — interactive API docs
- http://127.0.0.1:8000/health

Demo accounts (password `1234` for all):

```text
admin@supalai.com       role: admin
lead@supalai.com        role: sale_lead
mandee.jai@supalai.com  role: sale   (tag TAG01)
somchai.d@supalai.com   role: sale   (tag TAG02)
```

`sale` accounts only ever see their own visits — this is enforced
server-side (`queries.apply_scope`), not just hidden in the UI.

## 5. Google Sign-In (optional)

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

Restart the server after changing it. Google Sign-In only logs in an
*existing* user matched by email — it doesn't create new accounts.

## Connecting real UWB hardware

Once real anchors/tags exist:

1. Set `SIMULATOR_ENABLED=false` in `backend/.env`.
2. Register the project's anchors via `POST /api/projects/{id}/anchors`
   (or directly in the `anchors` table) with their real (x, y) survey
   positions.
3. Have your anchor gateway / tag firmware POST ranging results to
   `POST /api/positioning/{project_id}/ingest`:

   ```json
   {
     "tag_id": "TAG01",
     "ranges": [
       {"anchor_id": "A01", "distance_m": 9.85},
       {"anchor_id": "A02", "distance_m": 9.85},
       {"anchor_id": "A03", "distance_m": 12.73},
       {"anchor_id": "A04", "distance_m": 12.73}
     ]
   }
   ```

   (needs distances from at least 3 known anchors). The backend solves
   the position via least-squares multilateration (`positioning.py`),
   figures out which zone it landed in, records it, and keeps the
   visit lifecycle in sync — the exact same code path
   (`tracking.ingest_fix`) the simulator uses, so this is a drop-in
   replacement rather than a second implementation to maintain.

## What's implemented

- Email/password + optional Google Sign-In, session tokens
- Role-based access: `admin`, `sale_lead`, `sale` — `sale` is scoped to
  their own visits everywhere (visits list, overview, heatmap, notes,
  visit detail), enforced in the backend, not just the UI
- Live tag positions, anchor/tag online status, position trail
- Visit history with per-visit timeline, dwell-time-per-zone breakdown
  (signal-loss gaps over 5s excluded from dwell, not counted as
  standing still), and walked path, computed from raw `positions` rows
- Sales analytics: funnel, win/loss duration comparison, per-zone
  outcome comparison, per-person leaderboard, hour/weekday heatmaps
- Real anchor-placement suggestion and coverage-gap analysis
  (`calculations.py`) — grid-sampled, not a fixed 4-corner guess
- Real UWB multilateration (`positioning.py`)
- A live-position simulator standing in for real hardware
  (`simulator.py`)

## Project layout

```
backend/backend/
├── main.py          FastAPI app + all routes
├── config.py         env/settings
├── db.py              Postgres connection pool, schema/seed bootstrap
├── queries.py        reads/writes: users, projects, visits, analytics
├── tracking.py        position ingestion + visit open/close lifecycle
├── positioning.py    UWB multilateration math
├── calculations.py   anchor placement + coverage analysis
├── security.py        password hashing, session tokens
├── simulator.py       demo live-position generator
└── utils.py            time helpers (epoch <-> timestamptz)
```
