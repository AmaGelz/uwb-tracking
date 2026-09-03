# UWB

Indoor UWB (ultra-wideband) tracking dashboard for sales-gallery visits:
live floor-plan positions, per-visit dwell/timeline, and sales analytics
(funnel, win/loss duration, close rate by person and zone).

```
SUPALAI-UWB/
├── SUPALAI-UWB-frontend/   Static frontend (no build step) — vanilla JS/HTML/CSS
├── backend/backend/        FastAPI backend — see backend/README.md
├── database/                schema.sql + seed.sql (PostgreSQL / Supabase)
├── migration/migration.py   applies schema/seed to a Postgres database
├── data/config/              legacy reference JSON (see note below — no longer read by the app)
├── hardware/anchor, hardware/tag   placeholders for real UWB firmware (not yet implemented — see note below)
└── .env                      Supabase project URL/key
```

## Quickstart

```bash
cd backend
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
python -m venv .venv && source .venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
```

On Windows, `source .venv/bin/activate` doesn't exist — use PowerShell instead:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

If PowerShell refuses to run the script, run
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first, then
retry. Also make sure `python -m venv` is using a real Python install
(from [python.org](https://www.python.org/downloads/windows/)) and not
the Microsoft Store one — see
[Troubleshooting (Windows)](#troubleshooting-windows) below if `pip`
starts throwing `Unable to create process using
'...WindowsApps\PythonSoftwareFoundation...'`.

Put a Postgres connection string in `backend/.env` as `DATABASE_URL`
(Supabase dashboard → Project Settings → Database → Connection string
→ URI — see the comment in `backend/.env` for details), then:

```bash
cd ..
python migration/migration.py --seed
cd backend/backend
python main.py
```

Open **http://127.0.0.1:8000** — this backend serves the frontend
directly, so there's nothing else to run. Sign in with
`admin@supalai.com` / `1234` (see `backend/README.md` for the other
demo accounts and what each role can see).

No Supabase project yet? Leave `DATABASE_URL` empty and the backend
falls back to a local Postgres at `127.0.0.1:5432/supalai_test`,
creating its own schema and demo data on first boot.

## Troubleshooting (Windows)

These came up going through setup on Windows/PowerShell — recorded
here so the next person doesn't have to re-diagnose them from scratch.

**`ModuleNotFoundError: No module named 'fastapi'` after `pip install`**
The venv wasn't actually activated when `pip install` ran.
`source .venv/bin/activate` is macOS/Linux syntax and silently does
nothing useful on Windows. Use `.venv\Scripts\Activate.ps1` instead —
the prompt should show `(.venv)` before the path once it's active.

**`Unable to create process using '...WindowsApps\PythonSoftwareFoundation...'`**
The venv was created with the Microsoft Store build of Python, whose
`python.exe` is an app-execution-alias stub rather than a real binary
— it breaks when `pip`/`venv`'s generated launcher scripts try to spawn
it via a full path. Fix: install Python from
[python.org](https://www.python.org/downloads/windows/) (check "Add
python.exe to PATH"), delete the broken `.venv`, and recreate it with
`py -3.12 -m venv .venv` — the `py` launcher (not bare `python`) avoids
the Store alias. `.venv/pyvenv.cfg`'s `home`/`executable` lines should
point under `AppData\Local\Programs\Python\...`, never `WindowsApps`.

**`psycopg2.OperationalError: could not translate host name "db.<ref>.supabase.co"`**
Supabase's direct connection (`db.<ref>.supabase.co:5432`) is
IPv6-only on many projects now, and most Windows networks can't route
it. Use the **pooler** connection string instead — Supabase dashboard
→ Project Settings → Database → Connection string → **Transaction
pooler** tab (port `6543`, host
`aws-0-<region>.pooler.supabase.com`, username `postgres.<project-ref>`).

**Connection still fails after switching to the pooler string**
Check the password wasn't copied with the placeholder's brackets still
attached — `[YOUR-PASSWORD]` becomes `your-actual-password`, not
`[your-actual-password]`.

**`psycopg2.errors.UndefinedColumn: column "id" referenced in foreign key constraint does not exist` during migration**
Something already exists in the Supabase project's `public` schema
with a different shape than `schema.sql` expects — every table uses
`create table if not exists`, so a mismatched leftover table gets
skipped instead of fixed, and whatever references it fails. If the
project is dedicated to this app and has nothing else worth keeping,
reset it in the Supabase SQL editor:

```sql
drop schema public cascade;
create schema public;
grant all on schema public to postgres;
grant all on schema public to public;
```

then re-run `python migration/migration.py --seed`.

**`PermissionError: [WinError 5] Access is denied` right after `Started reloader process ... using WatchFiles`**
`uvicorn`'s `--reload` (tied to `DEBUG` in `backend/.env`) spawns a
watcher subprocess, and Windows sometimes refuses to hand it a process
handle — common when the project folder lives inside a OneDrive-synced
directory (e.g. `Downloads` redirected by a company OneDrive policy)
or with certain antivirus/endpoint software. `DEBUG` only controls
this reload behavior and nothing else, so setting `DEBUG=false` in
`backend/.env` sidesteps it with no other side effects.

## Database: Supabase / PostgreSQL

`database/schema.sql` is the full schema (idempotent — safe to re-run).
`database/seed.sql` is ~3 weeks of synthetic demo visits across two
sales reps so the analytics views have something real to show
immediately. Both get applied automatically every time the backend
starts, and can also be applied manually via `migration/migration.py`.

The backend connects with `psycopg2` directly against Postgres rather
than through the Supabase REST client — the analytics endpoints need
real SQL joins/aggregations that are awkward over PostgREST. Row Level
Security is enabled on every table with no policies attached, so if
`SUPABASE_URL`/`SUPABASE_KEY` (the anon key in root `.env`) is ever
used directly with `supabase-js`, it returns zero rows rather than
leaking data — all access control lives in the backend.

## No physical UWB hardware yet

`hardware/anchor/` and `hardware/tag/` are placeholders — writing
actual firmware needs to know the specific hardware (which UWB chip,
e.g. DW1000/DW3000, which MCU/board, which ranging protocol), which
this project doesn't currently specify. In the meantime:

- A background simulator (`backend/backend/simulator.py`) moves the
  seeded demo tags around the floor plan so the live map, visit
  history, and analytics all have real data to look at.
- Real hardware can be added per project, alongside the demo data,
  without turning the simulator off globally. Every tag is registered
  as `physical` or `mock` and every project as `hardware`,
  `simulation`, or `disabled`; the simulator only moves mock tags in
  simulation projects, and a gateway can only report physical tags in
  hardware projects. Registering a physical tag (or a gateway key)
  switches that one project to hardware mode.
- Gateways authenticate with a project-scoped key issued from the
  **จัดการแท็กและอุปกรณ์** admin page — shown once, stored only as a
  SHA-256 digest — and post to `POST /api/uwb/ingest` (FastAPI) or the
  `uwb-ingest` Edge Function (Supabase). Both paths solve the position
  with the same multilateration code, deduplicate retries by
  `message_id`, and keep the visit lifecycle in sync. See
  `backend/README.md` → "Real hardware and simulated demo data side by
  side".

## `data/config/*.json`

These are kept for reference (they're what the very first version of
this project used to configure zones/anchors/people before it moved to
a database), but **the running app no longer reads them** — zones and
anchors are project-scoped rows in Postgres now, editable via the
`/api/projects/{id}/anchors` endpoints, and people are rows in the
`users` table. If you were editing these files expecting the app to
pick up the changes, it won't — edit the database instead (or use
`database/seed.sql` as a template for more demo data).
