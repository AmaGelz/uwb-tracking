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

## Real hardware and simulated demo data side by side

Real and simulated tracking coexist per project, and nothing crosses
between them:

| | tag | project | who may write |
|---|---|---|---|
| real | `tag_type=physical` | `tracking_mode=hardware` | a gateway key |
| demo | `tag_type=mock` | `tracking_mode=simulation` | an admin session |

`tracking.validate_tracking_policy` enforces the pairing on every fix, so
a gateway cannot move a demo tag and the simulator cannot touch a real
one. A project switches to `hardware` automatically the moment a physical
tag or a gateway key is registered against it, and the simulator skips
those projects entirely (including their anchor heartbeats, so anchor
status reflects the real gateway).

### 1. Register the hardware

Anchors keep their existing route (`POST /api/projects/{id}/anchors`, or
the plan editor) with their real surveyed (x, y). Tags are registered
through the **จัดการแท็กและอุปกรณ์** page, or directly:

```http
POST /api/tags
{"tag_id": "UWB-0001", "hardware_uid": "DECA-0001",
 "tag_type": "physical", "project_id": "P900", "employee_id": "SALE001"}
```

`POST /api/tags/{tag_id}/assign` moves a tag to another project or
another employee: the previous assignment is ended rather than
overwritten and any visit still open is closed, so history stays
attributed to where it was recorded. `POST /api/tags/{tag_id}/deactivate`
retires a tag without deleting its history.

### 2. Issue a gateway key

```http
POST /api/projects/P900/gateways
{"gateway_id": "GW-P900-01"}
```

The response carries `gateway_key` **once** — only its SHA-256 digest is
stored, so it cannot be read back later. A lost key is replaced by
`POST /api/projects/{id}/gateways/{gateway_id}/revoke` plus a new one.

### 3. Point the gateway at the ingest endpoint

```http
POST /api/uwb/ingest
X-Gateway-Id: GW-P900-01
X-Gateway-Key: <the key from step 2>

{
  "message_id": "GW-P900-01-000123",
  "tag_id": "UWB-0001",
  "device_ts": 1772668800,
  "battery": 87,
  "ranges": [
    {"anchor_id": "A01", "distance_m": 9.85},
    {"anchor_id": "A02", "distance_m": 9.85},
    {"anchor_id": "A03", "distance_m": 12.73},
    {"anchor_id": "A04", "distance_m": 12.73}
  ]
}
```

- The project comes from the credential, never from the request body.
- Distances from at least 3 anchors known to that project are required;
  the backend solves the position by least-squares multilateration
  (`positioning.py`). A gateway that solves on-device may send `x`/`y`
  (plus optional `residual_m`/`anchors_used`) instead of `ranges`.
- `hardware_uid` may replace `tag_id` for firmware that only knows its
  own serial number.
- `message_id` makes retries safe: re-posting the same
  `(gateway_id, message_id)` returns the original fix with
  `"duplicate": true` instead of recording it twice or reopening a visit.
- `device_ts` accepts epoch seconds or ISO-8601 and is rejected if it is
  more than 5 minutes in the future or 15 minutes old — a broken clock or
  a replay is not a live position.

### Bench-testing without hardware

`POST /api/positioning/{project_id}/ingest` still exists for that: it is
authenticated as an admin session and accepts **mock** tags in a
**simulation** project. Both paths converge on `tracking.ingest_fix`,
which writes the position, the tag snapshot and the visit lifecycle in
one statement, so there is no second implementation to keep in step.

`SIMULATOR_ENABLED=false` in `backend/.env` turns the demo generator off
altogether.

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
- A tag registry that keeps real hardware and demo data apart, with
  assignment history, and gateway keys stored only as SHA-256 digests
  (`tracking.py`, `queries.py`)
- A live-position simulator standing in for real hardware, limited to
  mock tags in simulation-mode projects (`simulator.py`)

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
