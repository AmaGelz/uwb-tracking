from __future__ import annotations

import math
import secrets
from datetime import datetime
from typing import Any

from db import db
from utils import to_epoch, utc_now
import queries as q

# A tag counts as "gone" (visit should close) once it hasn't reported a
# fix for this long. Kept short because indoor UWB tags report at ~1Hz;
# a real gap this long means the visitor left, not that they paused.
PRESENCE_TIMEOUT_SEC = 20
TRACKING_SOURCES = {"hardware", "simulator"}


def _legacy_ingest_fix(tag_id: str, x: float, y: float, ts: datetime | None = None) -> dict[str, Any]:
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


class TrackingPolicyError(ValueError):
    """A fix is incompatible with the registered tag/project policy."""


class UnknownTagError(TrackingPolicyError):
    pass


class InactiveTagError(TrackingPolicyError):
    pass


class TagProjectMismatchError(TrackingPolicyError):
    pass


class TagSourceMismatchError(TrackingPolicyError):
    pass


class ProjectModeMismatchError(TrackingPolicyError):
    pass


def validate_tracking_policy(
    tag: dict[str, Any] | None,
    project_id: str | None,
    source: str,
    project_mode: str | None,
) -> str:
    """Validate the physical/mock boundary and return the assigned project."""
    if source not in TRACKING_SOURCES:
        raise TrackingPolicyError(f"unsupported position source: {source}")
    if not tag:
        raise UnknownTagError("tag is not registered")
    if tag.get("status") != "active":
        raise InactiveTagError("tag is disabled")

    assigned_project = tag.get("project_id")
    if not assigned_project:
        raise TagProjectMismatchError("tag has no active project assignment")
    if project_id is not None and assigned_project != project_id:
        raise TagProjectMismatchError(
            f"tag is assigned to {assigned_project}, not {project_id}"
        )

    expected_type = "physical" if source == "hardware" else "mock"
    if tag.get("tag_type") != expected_type:
        raise TagSourceMismatchError(
            f"{source} fixes require a {expected_type} tag"
        )

    expected_mode = "hardware" if source == "hardware" else "simulation"
    if project_mode != expected_mode:
        raise ProjectModeMismatchError(
            f"{source} fixes require project tracking_mode={expected_mode}"
        )
    return str(assigned_project)


def _position_result(row: dict[str, Any], *, duplicate: bool) -> dict[str, Any]:
    return {
        "x": row["x"],
        "y": row["y"],
        "zone": row.get("zone"),
        "ts": to_epoch(row.get("ts")),
        "project_id": row.get("project_id"),
        "plan_id": row.get("plan_id"),
        "source": row.get("source"),
        "gateway_id": row.get("gateway_id"),
        "message_id": row.get("message_id"),
        "duplicate": duplicate,
    }


def ingest_fix(
    tag_id: str,
    x: float,
    y: float,
    ts: datetime | None = None,
    *,
    project_id: str | None = None,
    plan_id: str | None = None,
    source: str = "simulator",
    gateway_id: str | None = None,
    message_id: str | None = None,
    device_ts: datetime | None = None,
    residual_m: float | None = None,
    anchors_used: int | None = None,
    battery: float | None = None,
) -> dict[str, Any]:
    """Atomically persist one fix, live state, and visit lifecycle.

    A repeated ``(gateway_id, message_id)`` returns the original position
    without advancing live state or creating another visit.
    """
    if not math.isfinite(float(x)) or not math.isfinite(float(y)):
        raise TrackingPolicyError("position coordinates must be finite")
    if battery is not None and (not math.isfinite(float(battery)) or not 0 <= battery <= 100):
        raise TrackingPolicyError("battery must be between 0 and 100")

    tag = q.get_tracking_tag(tag_id)
    assigned_project = tag.get("project_id") if tag else project_id
    project_mode = q.get_project_tracking_mode(assigned_project) if assigned_project else None
    resolved_project = validate_tracking_policy(tag, project_id, source, project_mode)

    if plan_id is None:
        active_plan = q.get_active_plan(resolved_project)
        plan_id = active_plan["plan_id"] if active_plan else None
    else:
        plan = q.get_plan(plan_id)
        if not plan or plan["project_id"] != resolved_project:
            raise TrackingPolicyError("plan does not belong to the tag's project")

    if message_id:
        if not gateway_id:
            gateway_id = f"legacy:{resolved_project}"
        existing = q.get_position_by_message_id(gateway_id, message_id)
        if existing:
            return _position_result(existing, duplicate=True)

    recorded_at = ts or utc_now()
    zones = q.get_plan_zones(plan_id) if plan_id else q.get_zones(resolved_project)
    zone = q.zone_for_point(zones, x, y)
    visit_key = f"V-{int(recorded_at.timestamp())}-{tag_id}-{secrets.token_hex(3)}"
    stored = q.record_position_fix(
        tag_id=tag_id,
        employee_id=tag.get("employee_id") if tag else None,
        project_id=resolved_project,
        plan_id=plan_id,
        x=x,
        y=y,
        zone=zone,
        source=source,
        gateway_id=gateway_id,
        message_id=message_id,
        device_ts=device_ts,
        residual_m=residual_m,
        anchors_used=anchors_used,
        battery=battery,
        ts=recorded_at,
        visit_key=visit_key,
    )

    # A concurrent retry can win the unique-key race after the early lookup.
    if stored is None and gateway_id and message_id:
        existing = q.get_position_by_message_id(gateway_id, message_id)
        if existing:
            return _position_result(existing, duplicate=True)
    if stored is None:
        raise RuntimeError("position fix was not stored")
    return _position_result(stored, duplicate=False)


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
        SELECT v.visit_key, v.tag_id, v.project_id, v.started_at, t.last_ts
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
            """
            SELECT zone, ts FROM positions
            WHERE tag_id = %s
              AND project_id IS NOT DISTINCT FROM %s
              AND ts >= %s AND ts <= %s
            ORDER BY ts ASC
            """,
            (row["tag_id"], row["project_id"], row["started_at"], end_ts),
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
