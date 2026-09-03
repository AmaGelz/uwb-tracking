# Tests

```bash
pip install pytest
pytest tests/ -v
```

These cover the pure-logic modules that don't need a database:
`positioning.py` (trilateration math), `calculations.py` (anchor
placement / coverage geometry), `security.py` (password hashing), the
live-hub fan-out, and `tracking.validate_tracking_policy` — the rule
that keeps real hardware and simulated demo data from mixing (a gateway
may only report physical tags in a hardware project, the simulator only
mock tags in a simulation project).

## What's *not* covered here

The API endpoints themselves (auth, role-based visit scoping, bootstrap
shape, the live simulator, etc.) were verified manually end-to-end
against a real Postgres instance during development — signing in as
each role, checking a `sale` account genuinely can't read or edit
another rep's visits even by forcing query parameters, watching the
simulator open/close visits and produce a real dwell-time breakdown,
and so on.

If you want to turn that into an automated suite, `fastapi.testclient.TestClient`
plus a scratch Postgres database (point `DATABASE_URL` at it before
importing `main`) is the way to do it — something like:

```python

import os
os.environ["DATABASE_URL"] = "postgresql://postgres:postgres@127.0.0.1:5432/supalai_pytest"
os.environ["SIMULATOR_ENABLED"] = "false"

from fastapi.testclient import TestClient
from main import app  # triggers init_db()/seed_demo_data() on startup

with TestClient(app) as client:
    r = client.post("/api/signin", json={"email": "admin@supalai.com", "password": "1234"})
    assert r.json()["ok"]
```
