# SUPALAI-UWB Frontend

This frontend preserves the original SUPALAI tracking-v02 UX/UI: fixed white header, quiet left rail, neutral surfaces, thin borders, KPI tiles, tables, filters, floor plan, status badges and the original Sign In / Google flow.

Files:
- index.html: entry/redirect
- login.html: original-style Sign In
- dashboard.html: dashboard shell + hash-routed screens
- css/style.css: original app(2).css moved without redesign
- js/api.js: session state + API transport
- js/auth.js: password + Google sign-in
- js/app.js: original dashboard rendering/routing

Backend endpoints are kept compatible with the paths this frontend was built against — see `../backend/README.md` for the current FastAPI implementation.
