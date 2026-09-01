# Migrating from Supabase to PostgreSQL

The target architecture is:

`browser / UWB gateway -> FastAPI -> PostgreSQL`

Neither browser JavaScript nor ESP32 firmware connects to PostgreSQL directly.
FastAPI owns credentials, sessions, authorization, SQL, hardware signature
validation, and live WebSocket fan-out.

## 1. Prepare the target

Create an empty PostgreSQL database and an application owner. Configure the API
host with:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
SEED_DEMO_DATA=false
SIMULATOR_ENABLED=false
HARDWARE_INGEST_SECRET=the-same-long-random-value-used-by-the-gateway
```

Apply the schema and ordered migrations without demo data:

```powershell
python migration/migration.py
```

## 2. Move application data

Back up the source before cutover. Migrate only the application's `public`
schema; Supabase-managed schemas such as `auth`, `storage`, and `realtime` are
not runtime dependencies after this change. A typical PostgreSQL-native export
is:

```text
pg_dump SOURCE_DATABASE_URL --schema=public --data-only --no-owner --exclude-table-data=public.sessions --exclude-table-data=public.hardware_ingest_receipts --format=custom --file=supalai-public-data.dump
pg_restore --dbname=TARGET_DATABASE_URL --data-only --no-owner supalai-public-data.dump
python migration/migration.py
```

Resolve any duplicates in a staging copy before the final cutover. Re-running
`migration.py` afterward applies column backfills and indexes to imported rows.

## 3. Plan authentication cutover

The API authenticates against `public.users.password_hash` and stores sessions
in `public.sessions`. Supabase Auth password hashes are not used by this code.
Existing users therefore need one of these before cutover:

- a valid application `password_hash` provisioned through an approved reset
  process; or
- an existing `public.users.email` plus `GOOGLE_CLIENT_ID` for Google sign-in.

Do not copy service-role keys or database passwords into frontend runtime
configuration. Existing Supabase JWTs will not become FastAPI sessions; users
sign in again after cutover.

## 4. Point clients at FastAPI

- Same-origin frontend: leave `SUPALAI-UWB-frontend/js/runtime-config.js`
  `apiBaseUrl` empty.
- Separately hosted frontend: set `apiBaseUrl` to FastAPI's public HTTPS origin
  and allow the frontend origin through `CORS_ORIGINS`.
- UWB gateway: re-run `scripts/configure-hardware-secret.ps1 -ApiBaseUrl
  https://api.example.com`, then verify the HTTPS root CA in
  `hardware/tag/supalai_tag/tls_root_ca.h` before flashing.

## 5. Cut over and verify

Pause writes to the old service, take a final data export, restore it, apply
migrations, then start FastAPI. Verify:

- `GET /health` reports `database: postgres`;
- password/Google sign-in creates a row in `sessions`;
- project, plan, device, visit, and analytics pages load;
- `POST /api/hardware/ingest` accepts a signed test frame only once per
  `(device_id, message_id)`;
- `/ws/live` updates the live map, with `/api/live` polling as fallback.

Keep the source database read-only until row counts and critical reports have
been reconciled and the rollback window has expired.
