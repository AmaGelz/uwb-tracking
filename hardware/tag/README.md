# Physical tag integration

Board-specific tag firmware is not included yet because the MCU, UWB chip, and
ranging protocol have not been selected. The dashboard, database, and ingest
API needed to register and display a real tag are implemented.

## Register the real tag

Sign in as an admin and open the tag/device management page, then create a tag
with:

- a unique `tag_id` used by the dashboard;
- the tag's unique `hardware_uid` or serial number;
- `tag_type=physical`;
- the project and, optionally, the employee carrying it.

Assigning a physical tag automatically changes that project to hardware mode.
One project can have many tags, but each tag can have only one active project
assignment. Moving a tag ends the previous assignment without deleting its
position or visit history.

For the current setup, register the one working tag as physical in its real
project. Keep the other demo tags as `tag_type=mock` in separate simulation
projects so their generated movement cannot be mistaken for hardware data.

## Firmware/gateway contract

The tag may report its `hardware_uid` to the gateway. The gateway combines that
identity with distances measured against the anchors and sends one JSON message
to the hardware ingest endpoint:

```json
{
  "message_id": "GW-P900-01-000123",
  "hardware_uid": "DECA-0001",
  "battery": 87,
  "ranges": [
    { "anchor_id": "A01", "distance_m": 9.85 },
    { "anchor_id": "A02", "distance_m": 9.85 },
    { "anchor_id": "A03", "distance_m": 12.73 }
  ]
}
```

The gateway must authenticate with its project-scoped `X-Gateway-Id` and
`X-Gateway-Key`. The backend rejects an unregistered/disabled tag, a mock tag,
or a physical tag assigned to a different project. Once accepted, the result is
stored in PostgreSQL and appears on the live dashboard through the FastAPI
WebSocket.

See `../anchor/README.md` for endpoints, headers, retry behavior, and the full
gateway flow.
