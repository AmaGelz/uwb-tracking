# Supabase production backend

Production uses project `supalai-tracking` for PostgreSQL, Auth, Realtime, the
`api` Edge Function and the public `site` Storage bucket. The FastAPI service
remains available as a local or legacy backend.

## Deploy

```powershell
npx.cmd --yes supabase@latest login --agent no
npx.cmd --yes supabase@latest link --project-ref jitmnaljkughkhmxeaov --agent no
npx.cmd --yes supabase@latest db push --linked --include-all --agent no
npx.cmd --yes supabase@latest config push --project-ref jitmnaljkughkhmxeaov --agent no
npx.cmd --yes supabase@latest functions deploy api --project-ref jitmnaljkughkhmxeaov --agent no
```

The migrations preserve legacy IDs and rows, link application profiles to
`auth.users`, add role-scoped RLS policies, and publish `positions`/`tags` to
Supabase Realtime. The Edge Function validates the Supabase JWT and application
role before using its server-only service-role credential. Never put a
service-role or secret key in frontend files or Cloudflare deployment variables.

New staff accounts should be created through an Auth invitation with role and
employee metadata. Public signup is disabled. Invite/recovery links return to
the configured production `login.html`, where the user sets a password of at
least eight characters.

Supabase Storage and the legacy public `site` Edge Function remain available,
but the default Supabase domain intentionally serves HTML as `text/plain`.
Cloudflare Workers Static Assets therefore serves the production frontend at:

`https://supalai-uwb-tracking.ordinary-plant.workers.dev`
