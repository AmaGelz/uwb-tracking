# SUPALAI-UWB Frontend

This frontend preserves the original SUPALAI tracking-v02 UX/UI: fixed white header, quiet left rail, neutral surfaces, thin borders, KPI tiles, tables, filters, floor plan, status badges and the original Sign In / Google flow.

Files:
- index.html: entry/redirect
- login.html: original-style Sign In
- dashboard.html: dashboard shell + hash-routed screens
- css/style.css: original app(2).css moved without redesign
- js/runtime-config.js: public Supabase URL/publishable key and Edge Function origin
- js/api.js: Supabase session state + Edge Function transport
- js/auth.js: Supabase password/invite/Google sign-in
- js/app.js: original dashboard rendering/routing

Production endpoints keep the existing `/api/...` contract through the
Supabase Edge Function in `../supabase/functions/api`. The FastAPI backend is
retained for local/legacy deployments.

## Supabase deployment

Supabase provides Auth, Postgres, Realtime, the Edge Function API and the
public static site.

Deploy Supabase migrations, functions and Storage objects as described in
`../supabase/README.md`. The production URL is
`https://jitmnaljkughkhmxeaov.supabase.co/functions/v1/site/index.html`.

If Google Sign-In is enabled, configure the Google provider in Supabase Auth
and allow the production `site` Edge Function URL as a redirect URL.
