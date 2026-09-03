# Supabase production backend

Production uses project `supalai-tracking` for PostgreSQL, Auth, Realtime, the
`api` and `uwb-ingest` Edge Functions and the public `site` Storage bucket. The
FastAPI service remains available as a local or legacy backend.

## Deploy

```powershell
npx.cmd --yes supabase@latest login --agent no
npx.cmd --yes supabase@latest link --project-ref jitmnaljkughkhmxeaov --agent no
npx.cmd --yes supabase@latest db push --linked --include-all --agent no
npx.cmd --yes supabase@latest config push --project-ref jitmnaljkughkhmxeaov --agent no
npx.cmd --yes supabase@latest functions deploy api --project-ref jitmnaljkughkhmxeaov --agent no
npx.cmd --yes supabase@latest functions deploy uwb-ingest --project-ref jitmnaljkughkhmxeaov --agent no
```

The migrations preserve legacy IDs and rows, link application profiles to
`auth.users`, add role-scoped RLS policies, and publish `positions`/`tags` to
Supabase Realtime. The Edge Function validates the Supabase JWT and application
role before using its server-only service-role credential. Never put a
service-role or secret key in frontend files or Cloudflare deployment variables.

## Hardware ingest

`uwb-ingest` is the endpoint real UWB gateways post to. A gateway is an
unattended device with no Supabase Auth session, so `verify_jwt` is off for
this function only and the credential is instead a project-scoped key an admin
issues with `POST /api/projects/{id}/gateways`. Only the SHA-256 digest of the
key is stored in `gateway_credentials`, and `gateway_credentials` deliberately
has no RLS policy, so its digests are reachable only through the service-role
credential the function holds.

```http
POST https://jitmnaljkughkhmxeaov.supabase.co/functions/v1/uwb-ingest
X-Gateway-Id: GW-P900-01
X-Gateway-Key: <shown once, at creation>

{"message_id": "GW-P900-01-000123", "tag_id": "UWB-0001",
 "battery": 87,
 "ranges": [{"anchor_id": "A01", "distance_m": 9.85}, ...]}
```

The project is taken from the credential, never from the request body. Each
accepted message is written through the `ingest_uwb_fix` RPC, which repeats the
tag / project / assignment checks inside the database and writes the position,
the tag snapshot and the visit in one transaction. Re-posting the same
`(gateway_id, message_id)` returns the original fix with `"duplicate": true`,
so a gateway retrying after a lost response cannot double-record a visit.

See `backend/README.md` for the request/response contract in full; the FastAPI
backend exposes the same flow at `POST /api/uwb/ingest`.

New staff accounts should be created through an Auth invitation with role and
employee metadata. Public signup is disabled. Invite/recovery links return to
the configured production `login.html`, where the user sets a password of at
least eight characters.

Supabase Storage and the legacy public `site` Edge Function remain available,
but the default Supabase domain intentionally serves HTML as `text/plain`.
Cloudflare Workers Static Assets therefore serves the production frontend at:

`https://supalai-uwb-tracking.ordinary-plant.workers.dev`
