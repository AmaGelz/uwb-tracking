# UWB

Indoor UWB (ultra-wideband) tracking dashboard for sales-gallery visits:
live floor-plan positions, per-visit dwell/timeline, and sales analytics
(funnel, win/loss duration, close rate by person and zone).

```
SUPALAI-UWB/
├── SUPALAI-UWB-frontend/   Static frontend (no build step) — vanilla JS/HTML/CSS
├── backend/backend/        FastAPI backend — see backend/README.md
├── database/                schema, migrations, and seed data (PostgreSQL)
├── migration/migration.py   applies schema/seed to a Postgres database
├── hardware/                ESP32 UWB firmware and PlatformIO sources
└── .env                      server-side PostgreSQL/API settings
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

Put a PostgreSQL connection string in `backend/.env` as `DATABASE_URL`, then:

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

## Azure App Service

Deploy the repository root to a Linux App Service using Python 3.12. Oryx
installs the root `requirements.txt`, which delegates to the Dashboard
backend requirements. Configure `DATABASE_URL` and
`HARDWARE_INGEST_SECRET` in **Configuration -> Application settings**. For
production, also set `SEED_DEMO_DATA=false`, `SIMULATOR_ENABLED=false`, and
normally `AUTO_MIGRATE=false` after applying migrations separately.

Set **Configuration -> General settings -> Startup Command** to:

```text
gunicorn --chdir backend/backend --bind=0.0.0.0 --timeout 600 --workers 2 --worker-class uvicorn.workers.UvicornWorker main:app
```

This starts only [the Dashboard FastAPI application](backend/backend/main.py),
which serves the frontend, authenticated APIs, WebSocket updates, and
`POST /api/hardware/ingest`. The same command is provided by `startup.sh`.
No separate root-level ingest application is deployed.

If `DATABASE_URL` is empty, the backend falls back to a local PostgreSQL
instance at `127.0.0.1:5432/supalai_test`,
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

**`psycopg2.errors.UndefinedColumn: column "id" referenced in foreign key constraint does not exist` during migration**
Something already exists in the target database's `public` schema
with a different shape than `schema.sql` expects — every table uses
`create table if not exists`, so a mismatched leftover table gets
skipped instead of fixed, and whatever references it fails. If the
database is dedicated to this app and has nothing else worth keeping,
recreate the database before applying the migration. Do not drop a shared
schema or a database that has not been backed up.

Then re-run `python migration/migration.py` (add `--seed` only for demo data).

**`PermissionError: [WinError 5] Access is denied` right after `Started reloader process ... using WatchFiles`**
`uvicorn`'s `--reload` (tied to `DEBUG` in `backend/.env`) spawns a
watcher subprocess, and Windows sometimes refuses to hand it a process
handle — common when the project folder lives inside a OneDrive-synced
directory (e.g. `Downloads` redirected by a company OneDrive policy)
or with certain antivirus/endpoint software. `DEBUG` only controls
this reload behavior and nothing else, so setting `DEBUG=false` in
`backend/.env` sidesteps it with no other side effects.

## Database: PostgreSQL

For local setup and inspecting the same database with DBeaver, follow
[`database/DBEAVER_SETUP.md`](database/DBEAVER_SETUP.md). DBeaver is the
administration client; FastAPI connects directly to PostgreSQL rather than
routing database traffic through DBeaver.

For a hosted cutover, follow
[`database/MIGRATING_FROM_SUPABASE.md`](database/MIGRATING_FROM_SUPABASE.md).

`database/schema.sql` plus `database/migrations/*.sql` define the schema and
are idempotent.
`database/seed.sql` is ~3 weeks of synthetic demo visits across two
sales reps so the analytics views have something real to show
immediately. Set `SEED_DEMO_DATA=false` in production. Schema changes can also
be applied manually via `migration/migration.py`.

The backend connects to PostgreSQL with `psycopg2`; browser and firmware
clients never receive database credentials. FastAPI owns authentication,
role checks, analytics SQL, hardware ingestion, and live WebSocket fan-out.

## UWB hardware

Makerfabs ESP32 UWB / DW1000 firmware and setup instructions live under
`hardware/`. See `hardware/PRODUCTION_SETUP.md` before flashing devices.

- A background simulator (`backend/backend/simulator.py`) moves the
  seeded demo tags around the floor plan so the live map, visit
  history, and analytics all have real data to look at.
- Production gateways send HMAC-signed ranging frames to
  `POST /api/hardware/ingest`; FastAPI maps surveyed anchors, calculates the
  fix, and writes one idempotent PostgreSQL transaction.
- The firmware already installed on the current Makerfabs tag can be retained.
  It exposes JSON ranging data on TCP port `8888`; run the legacy bridge after
  starting FastAPI:

  ```powershell
  cd backend
  & .\.venv\Scripts\python.exe -m backend.legacy_tag_bridge
  ```

  The computer must be able to reach the tag's existing IP (currently
  `192.168.1.200`). The bridge converts Makerfabs `A`/`R` links into the
  authenticated ingest API format, so no firmware flash is required.
