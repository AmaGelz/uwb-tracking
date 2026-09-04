# SUPALAI-UWB Frontend

This frontend preserves the original SUPALAI tracking-v02 UX/UI: fixed white header, quiet left rail, neutral surfaces, thin borders, KPI tiles, tables, filters, floor plan, status badges and the original Sign In / Google flow.

Files:
- index.html: entry/redirect
- login.html: original-style Sign In
- dashboard.html: dashboard shell + hash-routed screens
- css/style.css: original app(2).css moved without redesign
- js/runtime-config.js: optional public FastAPI origin
- js/api.js: FastAPI session header and HTTP/WebSocket URL transport
- js/auth.js: PostgreSQL-backed password and optional Google sign-in
- js/app.js: original dashboard rendering/routing

All endpoints use the `/api/...` contract served by the FastAPI backend.
Live positions use `/ws/live`, with authenticated HTTP polling as a fallback.

## Production deployment

The simplest deployment is to let FastAPI serve this directory. Keep
`apiBaseUrl` empty in `js/runtime-config.js`, run the backend, and open the
FastAPI origin. HTTP, authentication and WebSocket traffic then remain
same-origin.

If the static frontend is hosted separately, set `apiBaseUrl` to the public
HTTPS origin of FastAPI, add the frontend origin to `CORS_ORIGINS`, and make
sure the reverse proxy supports WebSocket upgrades. Never put `DATABASE_URL`
or a gateway key in a frontend file.

Optional Google Sign-In is verified by FastAPI using `GOOGLE_CLIENT_ID`.
