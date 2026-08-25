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

## Production deployment

Supabase provides Auth, Postgres, Realtime and the Edge Function API.
Cloudflare Workers Static Assets serves the public frontend without requiring
a Supabase custom-domain add-on.

Deploy the Supabase services as described in `../supabase/README.md`, then
deploy the repository's `wrangler.jsonc` configuration. The production URL is
`https://supalai-uwb-tracking.ordinary-plant.workers.dev`.

If Google Sign-In is enabled, configure the Google provider in Supabase Auth
and allow the production Cloudflare URL as a redirect URL.
