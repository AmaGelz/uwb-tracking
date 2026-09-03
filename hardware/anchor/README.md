# Anchor and gateway integration

The repository does not yet contain board-specific UWB firmware. The firmware
depends on the selected MCU/UWB chip and ranging protocol, but the server-side
contract for connecting real anchors is implemented.

## Data flow

1. Anchors measure their distance to a physical tag.
2. A gateway collects at least three anchor ranges (or calculates `x`/`y`
   itself).
3. The gateway posts the reading to the hardware ingest endpoint.
4. The backend authenticates the gateway, resolves the tag position, and
   writes the position, live tag snapshot, and visit state to PostgreSQL.
5. Supabase Realtime updates the dashboard.

Real hardware and demo traffic are isolated by project. A real deployment uses
a project with `tracking_mode=hardware`; mock tags remain in separate projects
with `tracking_mode=simulation`.

## Provision a project

As an admin:

1. Add the surveyed `(x, y)` coordinates for each anchor in the project's
   active plan.
2. Register the real tag as `tag_type=physical` and assign it to the project.
3. Create a gateway credential from the dashboard's tag/device management
   page. Copy the returned key immediately because it is displayed only once.

A project can contain any number of anchors and tags. A tag has only one active
project assignment at a time, while its previous assignments remain in
history.

## Send ranges

Production Supabase endpoint:

```text
POST https://jitmnaljkughkhmxeaov.supabase.co/functions/v1/uwb-ingest
X-Gateway-Id: GW-P900-01
X-Gateway-Key: <key shown when the gateway was created>
Content-Type: application/json
```

```json
{
  "message_id": "GW-P900-01-000123",
  "hardware_uid": "DECA-0001",
  "battery": 87,
  "ranges": [
    { "anchor_id": "A01", "distance_m": 9.85 },
    { "anchor_id": "A02", "distance_m": 9.85 },
    { "anchor_id": "A03", "distance_m": 12.73 },
    { "anchor_id": "A04", "distance_m": 12.73 }
  ]
}
```

`tag_id` may be sent instead of `hardware_uid`. The ranges must include at
least three distinct anchors registered to the gateway's project. A gateway
that already solves the position can send `x` and `y`, with optional
`residual_m` and `anchors_used`, instead of `ranges`.

`message_id` must be unique per gateway. Retrying the same message is safe and
returns `"duplicate": true`. Optional `device_ts` accepts the current epoch
seconds, epoch milliseconds, or ISO-8601; when omitted, server receipt time is
used. Readings more than 15 minutes old or more than five minutes in the future
are rejected.

The local FastAPI equivalent is `POST http://127.0.0.1:8000/api/uwb/ingest`
with the same gateway headers and payload. Do not send real hardware to
`/api/positioning/{project_id}/ingest`; that authenticated route is reserved
for mock/bench data in simulation projects.

See `../../supabase/README.md` and `../../backend/README.md` for deployment and
the complete backend setup.
