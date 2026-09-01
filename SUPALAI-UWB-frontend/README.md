# SUPALAI-UWB frontend

The frontend is static HTML/CSS/JavaScript and talks only to the FastAPI
service. FastAPI owns authentication, authorization, live WebSockets, and all
PostgreSQL access; database credentials must never be placed in this folder.

`js/runtime-config.js` leaves `apiBaseUrl` empty for the normal same-origin
deployment where FastAPI serves this directory. When hosting the static files
separately, set it to the public HTTPS origin of FastAPI and add the frontend
origin to `CORS_ORIGINS` on the API host.

The relevant boundaries are:

- `js/api.js`: API URL resolution, PostgreSQL-backed session token transport
- `js/auth.js`: email/password and optional Google Identity sign-in via FastAPI
- `js/app.js`: dashboard plus FastAPI WebSocket live updates/polling fallback

Do not add `DATABASE_URL`, PostgreSQL passwords, or hardware secrets to
`runtime-config.js`; all of those are server-side settings.
