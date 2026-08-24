from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any

from db import db
from utils import utc_now
import queries as q

# A tag counts as "gone" (visit should close) once it hasn't reported a
# fix for this long. Kept short because indoor UWB tags report at ~1Hz;
# a real gap this long means the visitor left, not that they paused.
PRESENCE_TIMEOUT_SEC = 20


def ingest_fix(tag_id: str, x: float, y: float, ts: datetime | None = None) -> dict[str, Any]:
    """Record one resolved (x, y) fix for a tag and keep its visit in sync.

    This is the single place that turns a raw position into: a `positions`
    row, an updated `tags` row, and — if this is the first fix after the
    tag was away — a newly opened `visits` row (closed later, once the tag
    goes quiet, by `sweep_stale_visits`). Both the demo simulator and the
    real hardware ingestion endpoint (`POST /api/positioning/{project}/ingest`)
    call this, so the logic only has to be right once.
    """
    ts = ts or utc_now()

    row = db.fetchone("SELECT employee_id, project_id FROM tags WHERE tag_id = %s", (tag_id,))
    project_id = row["project_id"] if row else None
    employee_id = row["employee_id"] if row else None

    zones = q.get_zones(project_id) if project_id else []
    zone = q.zone_for_point(zones, x, y)

    db.execute(
        "INSERT INTO positions (tag_id, x, y, zone, ts) VALUES (%s, %s, %s, %s, %s)",
        (tag_id, x, y, zone, ts),
    )
    db.execute("UPDATE tags SET x = %s, y = %s, last_ts = %s WHERE tag_id = %s", (x, y, ts, tag_id))

    open_visit = q.get_open_visit(tag_id)
    if not open_visit:
        project = q.get_project(project_id) if project_id else None
        plan_id = project["plan_id"] if project else None
        visit_key = f"V-{int(ts.timestamp())}-{tag_id}-{secrets.token_hex(3)}"
        q.start_visit(visit_key, tag_id, employee_id, project_id, plan_id, ts)

    return {"x": x, "y": y, "zone": zone, "ts": ts.timestamp()}


def sweep_stale_visits(timeout_sec: int = PRESENCE_TIMEOUT_SEC) -> int:
    """Close out any open visit whose tag has gone quiet for too long.

    The visit's `zone` (its "top zone" everywhere in the UI) is picked as
    whichever zone the tag spent the most time in during the visit,
    computed the same way the visit-detail dwell breakdown is —
    signal-loss gaps over DWELL_GAP_SEC are excluded so a dropped anchor
    reading doesn't get counted as dwell time in whatever zone came before it.
    """
    stale = db.fetchall(
        """
        SELECT v.visit_key, v.tag_id, v.started_at, t.last_ts
        FROM visits v
        JOIN tags t ON t.tag_id = v.tag_id
        WHERE v.ended_at IS NULL
          AND (t.last_ts IS NULL OR EXTRACT(EPOCH FROM (%s - t.last_ts)) > %s)
        """,
        (utc_now(), timeout_sec),
    )

    closed = 0
    for row in stale:
        end_ts = row["last_ts"] or row["started_at"]
        positions = db.fetchall(
            "SELECT zone, ts FROM positions WHERE tag_id = %s AND ts >= %s AND ts <= %s ORDER BY ts ASC",
            (row["tag_id"], row["started_at"], end_ts),
        )
        dwell: dict[str, float] = {}
        for i in range(1, len(positions)):
            gap = (positions[i]["ts"] - positions[i - 1]["ts"]).total_seconds()
            if 0 < gap <= q.DWELL_GAP_SEC:
                zone = positions[i - 1]["zone"] or "outside"
                dwell[zone] = dwell.get(zone, 0.0) + gap

        top_zone = max(dwell, key=dwell.get) if dwell else None
        duration_sec = max(0, int((end_ts - row["started_at"]).total_seconds()))
        q.close_visit(row["visit_key"], end_ts, duration_sec, top_zone)
        closed += 1

    return closed
