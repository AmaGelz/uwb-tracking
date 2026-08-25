# Supabase production backend

Production uses project `supalai-tracking` for PostgreSQL, Auth, Realtime and
the `api` Edge Function. The FastAPI service remains available as a local or
legacy backend, but GitHub Pages talks to Supabase directly.

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
service-role or secret key in frontend files or GitHub Pages variables.

New staff accounts should be created through an Auth invitation with role and
employee metadata. Public signup is disabled. Invite/recovery links return to
`https://amagelz.github.io/uwb-tracking/login.html`, where the user sets a
password of at least eight characters.
