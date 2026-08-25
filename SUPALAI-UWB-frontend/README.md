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

## GitHub Pages deployment

GitHub Pages hosts the static frontend. Supabase provides Auth, Postgres,
Realtime and the Edge Function API.

1. Deploy Supabase migrations and function as described in `../supabase/README.md`.
2. In **Settings → Pages**, select **GitHub Actions** as the source.
3. Push to `main`, or run **Deploy frontend to GitHub Pages** manually.

The workflow publishes `SUPALAI-UWB-frontend` as the site root. The expected
URL is `https://amagelz.github.io/uwb-tracking/`.

If Google Sign-In is enabled, configure the Google provider in Supabase Auth
and allow `https://amagelz.github.io/uwb-tracking/` as a redirect URL.
