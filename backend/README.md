# SUPALAI-UWB Backend

FastAPI backend for the SUPALAI Tracking dashboard. It is the only component
that talks directly to PostgreSQL; browser and firmware clients use its API.

## 1. Install

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## 2. Point it at a database

You need a PostgreSQL connection string for a database/user owned by this
application. The user must be able to create and alter the application tables
when startup migrations run.

Put it in `backend/.env`:

```env
DATABASE_URL=postgresql://supalai_app:[PASSWORD]@db.example.com:5432/supalai
```

Use the same host, port, database, user, and password when creating the
PostgreSQL connection in DBeaver. See
[`database/DBEAVER_SETUP.md`](../database/DBEAVER_SETUP.md) for the exact
field mapping and migration workflow. DBeaver does not need to be running for
the API to work.

Then create the schema (and load demo data):

```bash
cd ..   # repo root
python migration/migration.py --seed
```

`migration/migration.py` is idempotent — safe to run again later after
pulling schema changes. See `--help` for options, including
`--from-sqlite` if you have a prior SQLite deployment to bring over.

For local development, leave `DATABASE_URL` empty in `backend/.env`. The backend falls back to
`postgresql://postgres:postgres@127.0.0.1:5432/supalai_test` and will
create its own schema + seed data on first boot, as long as a local
Postgres is reachable there.

Set `SEED_DEMO_DATA=false` and `SIMULATOR_ENABLED=false` for a production
database so startup does not add demo accounts/visits or simulated positions.
When the production runtime role has data-only permissions, also set
`AUTO_MIGRATE=false` and have the database owner run `migration/migration.py`
as a separate deployment step. This prevents FastAPI startup from attempting
DDL with the restricted runtime role.

If the tables are owned by a DBA/migration role rather than the username in
`DATABASE_URL`, the owner must also edit the role name and run
[`database/configure_backend_role.sql`](../database/configure_backend_role.sql)
once. It grants only application-table access, sequence use, function
execution, and an RLS policy for that backend role; it does not grant schema
creation or table ownership.

Verify both connectivity and application-table permissions before starting:

```powershell
backend/.venv/Scripts/python.exe backend/check_database.py
```

The final line must be `app_schema_access=ok`. A successful TCP/login test by
itself is insufficient because PostgreSQL can accept a connection while
rejecting every application query.

## 3. Start the server

```bash
cd backend/backend
python main.py
```

or

```bash
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

For Azure App Service, deploy from the repository root and configure this
Startup Command:

```text
gunicorn --chdir backend/backend --bind=0.0.0.0 --timeout 600 --workers 2 --worker-class uvicorn.workers.UvicornWorker main:app
```

This is the only production ASGI application. UWB sources must send the
authenticated `/api/hardware/ingest` contract. If a device cannot produce that
format or HMAC signature itself, translate and sign its frames in a small edge
adapter; `backend.legacy_tag_bridge` is the working adapter for the existing
Makerfabs TCP format.

On startup it applies `database/schema.sql`, loads
`database/seed.sql` when `SEED_DEMO_DATA=true`, and — unless
`SIMULATOR_ENABLED=false` — starts a
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
GOOGLE_WORKSPACE_DOMAIN=supalai.com
```

Create a Web application OAuth client in Google Cloud and add the local and
deployed frontend URLs to Authorized JavaScript origins. Google Sign-In links
the verified Google `sub` identifier to a pre-provisioned local user with the
same email. It never stores the Google password. New users must be invited by
an Admin from Dashboard -> จัดการผู้ใช้งาน.

## Gmail API activation and password-reset email

The sign-in page links to the password-reset flow. Set these values in
`backend/.env` (or in the deployment's application settings):

```env
FRONTEND_BASE_URL=https://tracking.example.com
MAIL_PROVIDER=gmail_api
GMAIL_SENDER_EMAIL=no-reply@supalai.com
GOOGLE_SERVICE_ACCOUNT_FILE=/run/secrets/google-service-account.json
```

For unattended Google Workspace delivery:

1. Enable Gmail API in the Google Cloud project.
2. Create a service account and enable Domain-Wide Delegation.
3. In Google Admin Console, authorize that service account client ID for
   `https://www.googleapis.com/auth/gmail.send`.
4. Give the backend the JSON key through a secret file or Key Vault mount.
   Never commit it to this repository.

For a single mailbox without Domain-Wide Delegation, obtain offline OAuth
consent and configure `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`,
and `GMAIL_OAUTH_REFRESH_TOKEN` instead. SMTP remains available as a fallback.

Run `& .\.venv\Scripts\python.exe migration\migration.py` so the identity and
invitation migrations exist. If the
backend uses a restricted PostgreSQL role, re-run
`database/configure_backend_role.sql` as the table owner afterward. Reset
links are one-time use, expire after `PASSWORD_RESET_MINUTES` (30 by default),
and invalidate all existing sessions after a successful password change.

For local development only, when `DEBUG=true` and email is not configured, the
reset link is printed in the backend log instead of being emailed.

## Connecting real UWB hardware

Once real anchors/tags exist:

1. Set `SEED_DEMO_DATA=false`, `SIMULATOR_ENABLED=false`, and a long random
   `HARDWARE_INGEST_SECRET` in `backend/.env`.
2. In the plan editor, register surveyed anchors with their real `(x, y)` and
   `hardware_address`, then register the gateway and tag on that plan.
3. Have the gateway send HMAC-signed ranging results to
   `POST /api/hardware/ingest`:

   ```json
   {
     "message_id": "SUPALAI-TAG-GW-01-boot-1",
     "tag_id": "TAG01",
     "ranges": [
       {"anchor_id": "1782", "distance_m": 9.85},
       {"anchor_id": "1783", "distance_m": 9.85},
       {"anchor_id": "1784", "distance_m": 12.73}
     ]
   }
   ```

   The headers and signature format are implemented by the included firmware.
   See `hardware/PRODUCTION_SETUP.md`. The endpoint rejects stale/bad
   signatures and high-residual fixes, maps zones, and commits positions,
   device state, visits, and idempotency receipts in PostgreSQL.

### Keep the firmware already installed on a Makerfabs tag

The current board can also be used without reflashing. Its existing firmware
listens on TCP port `8888` and emits Makerfabs frames such as:

```json
{"tag_id":"tag0","links":[{"A":"1782","R":"2.34"}]}
```

Connect the computer to the same `192.168.1.x` network as the tag, start
FastAPI, and run the adapter from the `backend` directory:

```powershell
& .\.venv\Scripts\python.exe -m backend.legacy_tag_bridge
```

The defaults map board tag `tag0` to registered tag `TAG01`, use gateway
`SUPALAI-TAG-GW-01`, connect to `192.168.1.200:8888`, and post locally to
FastAPI. Override them with `UWB_LEGACY_*` settings shown in `.env.example`
or with `python -m backend.legacy_tag_bridge --help`.

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
