from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from db import db
from utils import to_epoch, utc_now

WON = "ปิดการขาย"
LOST = "ยกเลิกการขาย"
DEAL_STATUSES = [WON, LOST]
MIN_FOR_TREND = 10  # decided visits needed before analytics claims a "trend"

ANCHOR_ONLINE_SEC = 30
TAG_ONLINE_SEC = 5
DWELL_GAP_SEC = 5  # position gaps longer than this are signal loss, not standing still


# ---------------------------------------------------------------------
# Users & sessions
# ---------------------------------------------------------------------

def get_user_by_email(email: str) -> dict[str, Any] | None:
    return db.fetchone("SELECT * FROM users WHERE lower(email) = lower(%s)", (email,))


def get_user_by_id(user_id: str) -> dict[str, Any] | None:
    return db.fetchone("SELECT * FROM users WHERE id = %s", (user_id,))


def get_user_by_google_sub(google_sub: str) -> dict[str, Any] | None:
    return db.fetchone("SELECT * FROM users WHERE google_sub = %s", (google_sub,))


def link_google_account(user_id: str, google_sub: str) -> dict[str, Any] | None:
    return db.execute_returning(
        """
        UPDATE users
        SET google_sub = %s
        WHERE id = %s AND (google_sub IS NULL OR google_sub = %s)
        RETURNING *
        """,
        (google_sub, user_id, google_sub),
    )


def all_users() -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id, employee_id, email, role, position,
               first_th, last_th, first_en, last_en, phone, tag_id,
               password_hash, google_sub, account_status, activated_at, created_at
        FROM users
        ORDER BY employee_id
        """
    )


def delete_session(token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token = %s", (token,))


def get_session_user(token: str) -> str | None:
    row = db.fetchone("SELECT user_id, expires_at FROM sessions WHERE token = %s", (token,))
    if not row:
        return None
    expires = row["expires_at"]
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires <= utc_now():
        delete_session(token)
        return None
    return row["user_id"]


def has_recent_password_reset(user_id: str, cooldown_seconds: int, purpose: str = "reset") -> bool:
    row = db.fetchone(
        """
        SELECT 1
        FROM password_reset_tokens
        WHERE user_id = %s
          AND purpose = %s
          AND created_at > now() - (%s * interval '1 second')
        LIMIT 1
        """,
        (user_id, purpose, cooldown_seconds),
    )
    return row is not None


def create_password_reset(
    user_id: str,
    token_hash: str,
    expires_at: datetime,
    purpose: str = "reset",
) -> None:
    # A new request retires earlier links for this account. The CTE keeps the
    # invalidation and insertion in one transaction.
    db.execute(
        """
        WITH invalidated AS (
            UPDATE password_reset_tokens
            SET used_at = now()
            WHERE user_id = %s AND purpose = %s AND used_at IS NULL
            RETURNING token_hash
        )
        INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, purpose)
        VALUES (%s, %s, %s, %s)
        """,
        (user_id, purpose, token_hash, user_id, expires_at, purpose),
    )


def password_reset_is_valid(token_hash: str) -> bool:
    row = db.fetchone(
        """
        SELECT 1
        FROM password_reset_tokens
        WHERE token_hash = %s AND used_at IS NULL AND expires_at > now()
        """,
        (token_hash,),
    )
    return row is not None


def consume_password_reset(token_hash: str, new_password_hash: str) -> str | None:
    """Atomically consume a valid token, update the password, and sign out all devices."""
    row = db.execute_returning(
        """
        WITH claimed AS (
            UPDATE password_reset_tokens
            SET used_at = now()
            WHERE token_hash = %s
              AND used_at IS NULL
              AND expires_at > now()
            RETURNING user_id, purpose
        ), updated AS (
            UPDATE users AS u
            SET password_hash = %s,
                account_status = CASE
                    WHEN claimed.purpose = 'activation' THEN 'active'
                    ELSE u.account_status
                END,
                activated_at = CASE
                    WHEN claimed.purpose = 'activation' THEN now()
                    ELSE u.activated_at
                END
            FROM claimed
            WHERE u.id = claimed.user_id
            RETURNING u.id, claimed.purpose
        ), revoked AS (
            DELETE FROM sessions AS s
            USING updated
            WHERE s.user_id = updated.id
            RETURNING s.token
        )
        SELECT id, purpose FROM updated
        """,
        (token_hash, new_password_hash),
    )
    return str(row["purpose"]) if row else None


def create_invited_user(
    user_id: str,
    data: dict[str, Any],
    token_hash: str,
    expires_at: datetime,
) -> dict[str, Any] | None:
    row = db.execute_returning(
        """
        WITH created AS (
            INSERT INTO users (
                id, employee_id, email, password_hash, role, position,
                first_th, last_th, first_en, last_en, phone,
                account_status, activated_at
            )
            VALUES (%s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, 'pending', NULL)
            RETURNING id
        ), invited AS (
            INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, purpose)
            SELECT %s, id, %s, 'activation' FROM created
            RETURNING user_id
        )
        SELECT user_id FROM invited
        """,
        (
            user_id,
            data["employee_id"],
            data["email"],
            data["role"],
            data.get("position", ""),
            data.get("first_th", ""),
            data.get("last_th", ""),
            data.get("first_en", ""),
            data.get("last_en", ""),
            data.get("phone", ""),
            token_hash,
            expires_at,
        ),
    )
    return get_user_by_id(row["user_id"]) if row else None


# ---------------------------------------------------------------------
# Projects / zones / anchors / tags
# ---------------------------------------------------------------------

def get_projects() -> list[dict[str, Any]]:
    projects = db.fetchall(
        """
        SELECT id AS project_id, name, province, plan_id, plan_name, width_m, height_m,
               tracking_mode
        FROM projects
        ORDER BY name
        """
    )
    for project in projects:
        project["plans"] = [
            {**plan, "live": bool(plan["is_active"])}
            for plan in get_plans(project["project_id"])
        ]
        if not project["plans"] and project.get("plan_id"):
            project["plans"] = [{
                "plan_id": project["plan_id"],
                "name": project["plan_name"],
                "live": True,
            }]
    return projects


def get_project(project_id: str) -> dict[str, Any] | None:
    for row in get_projects():
        if row["project_id"] == project_id:
            row["anchors"] = get_anchors(project_id)
            row["zones"] = get_zones(project_id)
            return row
    return None


# ---------------------------------------------------------------------
# Plan editor
# ---------------------------------------------------------------------

def get_plans(project_id: str) -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id AS plan_id, project_id, name, width_m, height_m,
               is_active, version, created_at, updated_at
        FROM plans
        WHERE project_id = %s
        ORDER BY is_active DESC, name, id
        """,
        (project_id,),
    )


def get_plan(plan_id: str) -> dict[str, Any] | None:
    return db.fetchone(
        """
        SELECT id AS plan_id, project_id, name, width_m, height_m,
               is_active, version, created_at, updated_at
        FROM plans
        WHERE id = %s
        """,
        (plan_id,),
    )


def sync_project_plan(project_id: str) -> None:
    """Keep legacy project plan columns aligned with the canonical plans table."""
    db.execute(
        """
        UPDATE projects AS project
        SET plan_id = selected.id,
            plan_name = selected.name,
            width_m = selected.width_m,
            height_m = selected.height_m
        FROM (
            SELECT id, name, width_m, height_m
            FROM plans
            WHERE project_id = %s
            ORDER BY is_active DESC, updated_at DESC, id
            LIMIT 1
        ) AS selected
        WHERE project.id = %s
        """,
        (project_id, project_id),
    )


def create_plan(project_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    plan = db.fetchone(
        """
        WITH inserted AS (
            INSERT INTO plans (
                id, project_id, name, width_m, height_m, is_active, version
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
            RETURNING *
        ), deactivated AS (
            UPDATE plans AS p
            SET is_active = false, updated_at = now()
            FROM inserted AS i
            WHERE i.is_active
              AND p.project_id = i.project_id
              AND p.id <> i.id
            RETURNING p.id
        ), synced_project AS (
            UPDATE projects AS p
            SET plan_id = i.id,
                plan_name = i.name,
                width_m = i.width_m,
                height_m = i.height_m
            FROM inserted AS i
            WHERE i.is_active AND p.id = i.project_id
            RETURNING p.id
        )
        SELECT id AS plan_id, project_id, name, width_m, height_m,
               is_active, version, created_at, updated_at
        FROM inserted
        """,
        (
            data["plan_id"], project_id, data["name"],
            data["width_m"], data["height_m"],
            data.get("is_active", False), data.get("version", 1),
        ),
    )
    if plan:
        sync_project_plan(project_id)
    return plan


def update_plan(plan_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "width_m", "height_m", "is_active", "version"}
    changes = [(key, value) for key, value in data.items() if key in allowed]
    if not changes:
        return get_plan(plan_id)

    assignments = ", ".join(f"{key} = %s" for key, _value in changes)
    params = [value for _key, value in changes]
    params.append(plan_id)

    plan = db.fetchone(
        f"""
        WITH updated AS (
            UPDATE plans
            SET {assignments}, updated_at = now()
            WHERE id = %s
            RETURNING *
        ), deactivated AS (
            UPDATE plans AS p
            SET is_active = false, updated_at = now()
            FROM updated AS u
            WHERE u.is_active
              AND p.project_id = u.project_id
              AND p.id <> u.id
            RETURNING p.id
        ), synced_project AS (
            UPDATE projects AS p
            SET plan_id = u.id,
                plan_name = u.name,
                width_m = u.width_m,
                height_m = u.height_m
            FROM updated AS u
            WHERE u.is_active AND p.id = u.project_id
            RETURNING p.id
        )
        SELECT id AS plan_id, project_id, name, width_m, height_m,
               is_active, version, created_at, updated_at
        FROM updated
        """,
        tuple(params),
    )
    if plan:
        sync_project_plan(plan["project_id"])
    return plan


def get_plan_objects(plan_id: str) -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id AS object_id, plan_id, object_type, label, geometry,
               properties, created_at, updated_at
        FROM plan_objects
        WHERE plan_id = %s
        ORDER BY id
        """,
        (plan_id,),
    )


def create_plan_object(plan_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    return db.fetchone(
        """
        INSERT INTO plan_objects (plan_id, object_type, label, geometry, properties)
        SELECT id, %s, %s, %s::jsonb, %s::jsonb
        FROM plans
        WHERE id = %s
        RETURNING id AS object_id, plan_id, object_type, label, geometry,
                  properties, created_at, updated_at
        """,
        (
            data["object_type"], data.get("label"), json.dumps(data["geometry"]),
            json.dumps(data.get("properties", {})), plan_id,
        ),
    )


def update_plan_object(plan_id: str, object_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"object_type", "label", "geometry", "properties"}
    changes = [(key, value) for key, value in data.items() if key in allowed]
    if not changes:
        return None

    assignments: list[str] = []
    params: list[Any] = []
    for key, value in changes:
        if key in {"geometry", "properties"}:
            assignments.append(f"{key} = %s::jsonb")
            params.append(json.dumps(value))
        else:
            assignments.append(f"{key} = %s")
            params.append(value)
    params.extend((plan_id, object_id))

    return db.fetchone(
        f"""
        UPDATE plan_objects
        SET {', '.join(assignments)}, updated_at = now()
        WHERE plan_id = %s AND id = %s
        RETURNING id AS object_id, plan_id, object_type, label, geometry,
                  properties, created_at, updated_at
        """,
        tuple(params),
    )


def delete_plan_object(plan_id: str, object_id: int) -> bool:
    row = db.execute_returning(
        "DELETE FROM plan_objects WHERE plan_id = %s AND id = %s RETURNING id",
        (plan_id, object_id),
    )
    return row is not None


def get_plan_zones(plan_id: str) -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id AS zone_id, plan_id, project_id, name,
               x_min, x_max, y_min, y_max, geometry
        FROM zones
        WHERE plan_id = %s
        ORDER BY id
        """,
        (plan_id,),
    )


def create_plan_zone(plan_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    return db.fetchone(
        """
        INSERT INTO zones (
            project_id, plan_id, name, x_min, x_max, y_min, y_max, geometry
        )
        SELECT project_id, id, %s, %s, %s, %s, %s, %s::jsonb
        FROM plans
        WHERE id = %s
        RETURNING id AS zone_id, plan_id, project_id, name,
                  x_min, x_max, y_min, y_max, geometry
        """,
        (
            data["name"], data["x_min"], data["x_max"],
            data["y_min"], data["y_max"], json.dumps(data["geometry"]), plan_id,
        ),
    )


def get_plan_anchors(plan_id: str) -> list[dict[str, Any]]:
    rows = db.fetchall(
        """
        SELECT anchor_id, project_id, plan_id, hardware_address, x, y, z, mount_height_m,
               battery, last_ts
        FROM anchors
        WHERE plan_id = %s
        ORDER BY anchor_id
        """,
        (plan_id,),
    )
    now = utc_now()
    for anchor in rows:
        anchor["on"] = bool(
            anchor["last_ts"]
            and (now - anchor["last_ts"]).total_seconds() <= ANCHOR_ONLINE_SEC
        )
        anchor["last_ts"] = to_epoch(anchor["last_ts"])
    return rows


def create_plan_anchor(plan_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    row = db.fetchone(
        """
        INSERT INTO anchors (
            project_id, plan_id, anchor_id, hardware_address, x, y, z, mount_height_m,
            battery, last_ts
        )
        SELECT project_id, id, %s, %s, %s, %s, %s, %s, %s, %s
        FROM plans
        WHERE id = %s
        ON CONFLICT (project_id, anchor_id)
        DO UPDATE SET
            plan_id = EXCLUDED.plan_id,
            hardware_address = EXCLUDED.hardware_address,
            x = EXCLUDED.x,
            y = EXCLUDED.y,
            z = EXCLUDED.z,
            mount_height_m = EXCLUDED.mount_height_m,
            battery = EXCLUDED.battery,
            last_ts = EXCLUDED.last_ts
        RETURNING anchor_id
        """,
        (
            data["anchor_id"], data.get("hardware_address"), data["x"], data["y"], data.get("z"),
            data.get("mount_height_m"), data.get("battery"), utc_now(), plan_id,
        ),
    )
    if not row:
        return None
    return next(
        anchor for anchor in get_plan_anchors(plan_id)
        if anchor["anchor_id"] == data["anchor_id"]
    )


def get_plan_dimensions(plan_id: str) -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id AS dimension_id, plan_id, x1, y1, x2, y2,
               length_m, angle_deg, label, created_at, updated_at
        FROM plan_dimensions
        WHERE plan_id = %s
        ORDER BY id
        """,
        (plan_id,),
    )


def create_plan_dimension(plan_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
    return db.fetchone(
        """
        INSERT INTO plan_dimensions (
            plan_id, x1, y1, x2, y2, length_m, angle_deg, label
        )
        SELECT id, %s, %s, %s, %s, %s, %s, %s
        FROM plans
        WHERE id = %s
        RETURNING id AS dimension_id, plan_id, x1, y1, x2, y2,
                  length_m, angle_deg, label, created_at, updated_at
        """,
        (
            data["x1"], data["y1"], data["x2"], data["y2"],
            data["length_m"], data.get("angle_deg", 0), data.get("label"), plan_id,
        ),
    )


def get_zones(project_id: str) -> list[dict[str, Any]]:
    return db.fetchall(
        "SELECT name, x_min, x_max, y_min, y_max FROM zones WHERE project_id = %s ORDER BY id",
        (project_id,),
    )


def zone_for_point(zones: list[dict[str, Any]], x: float, y: float) -> str | None:
    for z in zones:
        if z["x_min"] <= x <= z["x_max"] and z["y_min"] <= y <= z["y_max"]:
            return z["name"]
    return None


def get_anchors(project_id: str | None = None, plan_id: str | None = None) -> list[dict[str, Any]]:
    conditions: list[str] = []
    params: list[Any] = []
    if project_id:
        conditions.append("project_id = %s")
        params.append(project_id)
    if plan_id:
        conditions.append("plan_id = %s")
        params.append(plan_id)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = db.fetchall(
        f"""
        SELECT anchor_id, project_id, plan_id, hardware_address, x, y, z,
               mount_height_m, battery, last_ts
        FROM anchors
        {where}
        ORDER BY anchor_id
        """,
        tuple(params),
    )
    now = utc_now()
    for a in rows:
        a["on"] = bool(a["last_ts"] and (now - a["last_ts"]).total_seconds() <= ANCHOR_ONLINE_SEC)
        a["last_ts"] = to_epoch(a["last_ts"])
    return rows


def touch_anchors(project_id: str) -> None:
    db.execute("UPDATE anchors SET last_ts = %s WHERE project_id = %s", (utc_now(), project_id))


def get_tags(project_id: str | None = None, plan_id: str | None = None) -> list[dict[str, Any]]:
    conditions: list[str] = []
    params: list[Any] = []
    if project_id:
        conditions.append("t.project_id = %s")
        params.append(project_id)
    if plan_id:
        conditions.append("t.plan_id = %s")
        params.append(plan_id)
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    rows = db.fetchall(
        f"""
        SELECT t.tag_id, t.project_id, t.plan_id, t.x, t.y, t.z,
               t.battery, t.last_ts, t.source, t.device_id,
               u.first_en || ' ' || u.last_en AS sale_name
        FROM tags t
        LEFT JOIN users u ON u.employee_id = t.employee_id
        {where}
        ORDER BY t.tag_id
        """,
        tuple(params),
    )
    now = utc_now()
    for t in rows:
        t["on"] = bool(t["last_ts"] and (now - t["last_ts"]).total_seconds() <= TAG_ONLINE_SEC)
        t["last_ts"] = to_epoch(t["last_ts"])
    return rows


def get_live_tags(
    rows: int = 400,
    since: float = 0,
    project_id: str | None = None,
    plan_id: str | None = None,
) -> dict[str, Any]:
    rows = min(max(rows, 0), 5000)
    tags = get_tags(project_id, plan_id)
    result = {
        t["tag_id"]: {
            "project_id": t["project_id"],
            "plan_id": t["plan_id"],
            "x": t["x"],
            "y": t["y"],
            "z": t["z"],
            "battery": t["battery"],
            "on": t["on"],
            "sale_name": t["sale_name"],
            "last_ts": t["last_ts"],
            "source": t["source"],
            "device_id": t["device_id"],
        }
        for t in tags
    }

    trail: list[dict[str, Any]] = []
    if rows > 0:
        since_dt = datetime.fromtimestamp(since, tz=timezone.utc) if since else None
        conditions: list[str] = []
        params: list[Any] = []
        if since_dt:
            conditions.append("ts > %s")
            params.append(since_dt)
        if project_id:
            conditions.append("project_id = %s")
            params.append(project_id)
        if plan_id:
            conditions.append("plan_id = %s")
            params.append(plan_id)
        clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        trail_rows = db.fetchall(
            f"""SELECT tag_id, project_id, plan_id, x, y, z, zone, ts,
                       source, residual_m, anchors_used, device_id
                FROM positions {clause} ORDER BY ts DESC LIMIT %s""",
            (*params, rows),
        )
        trail = [
            {**r, "ts": to_epoch(r["ts"])}
            for r in trail_rows
        ]

    return {"ok": True, "now": to_epoch(utc_now()), "tags": result, "rows": trail}


def create_project(data: dict[str, Any]) -> dict[str, Any]:
    db.execute(
        """
        INSERT INTO projects (id, name, province, plan_id, plan_name, width_m, height_m)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        (
            data["project_id"], data["name"], data.get("province", ""),
            data.get("plan_id", ""), data.get("plan_name", ""),
            data.get("width_m", 20), data.get("height_m", 20),
        ),
    )
    return {"ok": True, "project": get_project(data["project_id"])}


def create_anchor(project_id: str, data: dict[str, Any]) -> dict[str, Any]:
    db.execute(
        """
        INSERT INTO anchors (project_id, anchor_id, x, y, battery, last_ts)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (project_id, anchor_id)
        DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, battery = EXCLUDED.battery, last_ts = EXCLUDED.last_ts
        """,
        (project_id, data["anchor_id"], data["x"], data["y"], data.get("battery"), utc_now()),
    )
    return {"ok": True, "anchor": next(a for a in get_anchors(project_id) if a["anchor_id"] == data["anchor_id"])}


def live_project_id() -> str | None:
    """The project actively wired up with UWB hardware (has anchors).

    The dashboard's floor-plan views (overview, sales map, device
    tracking, visit path overlay) all show one physical site rather
    than letting the user pick a project per chart, so bootstrap needs
    a single answer for "which floor plan". We use the first project
    (by name) that has at least one anchor; falls back to the first
    project if none have anchors yet.
    """
    projects = get_projects()
    if not projects:
        return None
    for p in projects:
        if get_anchors(p["project_id"]):
            return p["project_id"]
    return projects[0]["project_id"]


# ---------------------------------------------------------------------
# Visits
# ---------------------------------------------------------------------

def _visit_filters(q: dict[str, str]) -> tuple[str, list[Any]]:
    clauses = ["1=1"]
    params: list[Any] = []

    if q.get("province"):
        clauses.append("EXISTS (SELECT 1 FROM projects p WHERE p.id = v.project_id AND p.province = %s)")
        params.append(q["province"])
    if q.get("project"):
        clauses.append("v.project_id = %s")
        params.append(q["project"])
    if q.get("plan"):
        clauses.append("v.plan_id = %s")
        params.append(q["plan"])
    if q.get("employee"):
        clauses.append("v.employee_id = %s")
        params.append(q["employee"])
    if q.get("customer"):
        clauses.append("v.customer_id = %s")
        params.append(q["customer"])
    if q.get("from"):
        # The frontend sends epoch seconds (see rangeQuery()/toEpoch() in app.js),
        # not a date string, so this must parse as a float, not `date(...)`.
        try:
            clauses.append("v.started_at >= %s")
            params.append(datetime.fromtimestamp(float(q["from"]), tz=timezone.utc))
        except (ValueError, TypeError):
            pass
    if q.get("to"):
        try:
            clauses.append("v.started_at <= %s")
            params.append(datetime.fromtimestamp(float(q["to"]), tz=timezone.utc))
        except (ValueError, TypeError):
            pass

    return " AND ".join(clauses), params


def apply_scope(q: dict[str, str], viewer: dict[str, Any]) -> tuple[dict[str, str], str]:
    """A 'sale' viewer only ever sees their own visits, no matter what
    an `employee` filter in the query string says — otherwise scoping
    would just be a client-side courtesy anyone could bypass with curl."""
    if viewer["role"] == "sale":
        scoped = dict(q)
        scoped["employee"] = viewer["employee_id"]
        return scoped, "sale"
    return q, "all"


def get_visits(q: dict[str, str]) -> list[dict[str, Any]]:
    where, params = _visit_filters(q)
    rows = db.fetchall(
        f"""
        SELECT
            v.visit_key, v.tag_id, v.employee_id,
            u.first_en || ' ' || u.last_en AS sale_name,
            v.project_id, p.name AS project_name,
            v.plan_id, v.customer_id, c.name AS customer_name,
            v.started_at, v.ended_at, v.duration_sec, v.zone, v.deal_status
        FROM visits v
        LEFT JOIN users u ON u.employee_id = v.employee_id
        LEFT JOIN projects p ON p.id = v.project_id
        LEFT JOIN customers c ON c.id = v.customer_id
        WHERE {where}
        ORDER BY v.started_at DESC
        LIMIT 400
        """,
        tuple(params),
    )
    for v in rows:
        v["start_ts"] = to_epoch(v.pop("started_at"))
        v["end_ts"] = to_epoch(v.pop("ended_at"))
        v["duration"] = v.pop("duration_sec")
        v["top_zone"] = v.pop("zone")
    return rows


def get_visit(key: str) -> dict[str, Any] | None:
    row = db.fetchone(
        """
        SELECT v.*, u.first_en || ' ' || u.last_en AS sale_name,
               p.name AS project_name, c.name AS customer_name
        FROM visits v
        LEFT JOIN users u ON u.employee_id = v.employee_id
        LEFT JOIN projects p ON p.id = v.project_id
        LEFT JOIN customers c ON c.id = v.customer_id
        WHERE v.visit_key = %s
        """,
        (key,),
    )
    if not row:
        return None

    start = row["started_at"]
    end = row["ended_at"] or utc_now()

    positions = db.fetchall(
        """
        SELECT x, y, zone, ts FROM positions
        WHERE tag_id = %s AND ts >= %s AND ts <= %s
        ORDER BY ts ASC
        LIMIT 5000
        """,
        (row["tag_id"], start, end),
    )

    timeline = [{"ts": to_epoch(p["ts"]), "zone": p["zone"] or "outside"} for p in positions]

    dwell_map: dict[str, float] = {}
    dwell_first: dict[str, float] = {}
    dwell_dropped = 0.0
    for i in range(1, len(positions)):
        prev, cur = positions[i - 1], positions[i]
        gap = (cur["ts"] - prev["ts"]).total_seconds()
        if gap <= 0:
            continue
        zone = prev["zone"] or "outside"
        if gap > DWELL_GAP_SEC:
            dwell_dropped += gap
            continue
        dwell_map[zone] = dwell_map.get(zone, 0.0) + gap
        dwell_first.setdefault(zone, to_epoch(prev["ts"]))

    total_dwell = sum(dwell_map.values()) or 1.0
    dwell = [
        {"zone": z, "first_ts": dwell_first.get(z), "seconds": round(sec, 1), "pct": round(100 * sec / total_dwell, 1)}
        for z, sec in sorted(dwell_map.items(), key=lambda kv: -kv[1])
    ]

    path = [[p["x"], p["y"]] for p in positions]
    if len(path) > 400:
        step = len(path) // 400 + 1
        path = path[::step]

    row["notes"] = db.fetchall(
        """
        SELECT n.body, n.created_at, u.first_en || ' ' || u.last_en AS author
        FROM notes n
        LEFT JOIN users u ON u.id = n.user_id
        WHERE n.visit_key = %s
        ORDER BY n.created_at DESC
        """,
        (key,),
    )
    for n in row["notes"]:
        n["created_at"] = to_epoch(n["created_at"])

    row["start_ts"] = to_epoch(row.pop("started_at"))
    row["end_ts"] = to_epoch(row.pop("ended_at"))
    row["duration"] = row.pop("duration_sec")
    row["top_zone"] = row.pop("zone")
    row["fixes"] = len(positions)
    row["timeline"] = timeline
    row["dwell"] = dwell
    row["dwell_dropped"] = round(dwell_dropped, 1)
    row["path"] = path
    return row


def get_open_visit(tag_id: str) -> dict[str, Any] | None:
    return db.fetchone(
        "SELECT * FROM visits WHERE tag_id = %s AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        (tag_id,),
    )


def start_visit(visit_key: str, tag_id: str, employee_id: str | None, project_id: str | None,
                 plan_id: str | None, started_at: datetime) -> None:
    db.execute(
        """
        INSERT INTO visits (visit_key, tag_id, employee_id, project_id, plan_id, started_at, deal_status)
        VALUES (%s, %s, %s, %s, %s, %s, '')
        ON CONFLICT (visit_key) DO NOTHING
        """,
        (visit_key, tag_id, employee_id, project_id, plan_id, started_at),
    )


def close_visit(visit_key: str, ended_at: datetime, duration_sec: int, zone: str | None) -> None:
    db.execute(
        "UPDATE visits SET ended_at = %s, duration_sec = %s, zone = %s WHERE visit_key = %s",
        (ended_at, duration_sec, zone, visit_key),
    )


def set_visit_meta(visit_key: str, customer_id: str, deal_status: str) -> None:
    db.execute(
        "UPDATE visits SET customer_id = %s, deal_status = %s WHERE visit_key = %s",
        (customer_id, deal_status, visit_key),
    )


def add_note(visit_key: str, user_id: str, body: str) -> None:
    db.execute(
        "INSERT INTO notes (visit_key, user_id, body, created_at) VALUES (%s, %s, %s, %s)",
        (visit_key, user_id, body, utc_now()),
    )


# ---------------------------------------------------------------------
# Overview / heatmap / analytics
# ---------------------------------------------------------------------

def get_overview(q: dict[str, str]) -> dict[str, Any]:
    visits = get_visits(q)
    anchors = get_anchors()
    tags = get_tags()

    durations = [v["duration"] for v in visits if v["duration"] is not None]
    avg_duration = sum(durations) / len(durations) if durations else 0

    decided = [v for v in visits if v["deal_status"] in (WON, LOST)]
    won = [v for v in decided if v["deal_status"] == WON]
    close_rate = 100 * len(won) / len(decided) if decided else None

    return {
        "ok": True,
        "visits": len(visits),
        "anchors_on": sum(1 for a in anchors if a["on"]),
        "anchors_total": len(anchors),
        "tags_on": sum(1 for t in tags if t["on"]),
        "tags_total": len(tags),
        "avg_duration": avg_duration,
        "close_rate": close_rate,
    }


def get_heatmap(q: dict[str, str]) -> dict[str, Any]:
    visits = get_visits(q)
    buckets: dict[str, int] = {}
    for v in visits:
        if v["start_ts"] is None:
            continue
        dt = datetime.fromtimestamp(v["start_ts"], tz=timezone.utc)
        key = dt.strftime("%Y-%m-%dT%H")
        buckets[key] = buckets.get(key, 0) + 1

    rows = [{"bucket": k, "visits": v} for k, v in sorted(buckets.items())]
    peak = max((r["visits"] for r in rows), default=1)
    return {"ok": True, "rows": rows, "peak": peak}


def get_analytics(q: dict[str, str]) -> dict[str, Any]:
    visits = get_visits(q)

    n_visits = len(visits)
    with_customer = sum(1 for v in visits if v["customer_id"])
    decided = [v for v in visits if v["deal_status"] in (WON, LOST)]
    won = [v for v in decided if v["deal_status"] == WON]
    lost = [v for v in decided if v["deal_status"] == LOST]
    unlabelled = n_visits - len(decided)

    durations_all = [v["duration"] for v in visits if v["duration"] is not None]
    avg_duration = sum(durations_all) / len(durations_all) if durations_all else 0
    close_rate = 100 * len(won) / len(decided) if decided else None

    funnel = [
        {"label": "การเยี่ยมชมทั้งหมด", "n": n_visits},
        {"label": "บันทึกรหัสลูกค้าแล้ว", "n": with_customer},
        {"label": "ระบุผลการขายแล้ว", "n": len(decided)},
        {"label": "ปิดการขายได้", "n": len(won)},
    ]

    def _avg(items: list[dict[str, Any]]) -> float | None:
        durs = [v["duration"] for v in items if v["duration"] is not None]
        return (sum(durs) / len(durs)) if durs else None

    duration_by_outcome = {
        "won": {"n": len(won), "avg": _avg(won)},
        "lost": {"n": len(lost), "avg": _avg(lost)},
    }

    zone_buckets: dict[str, dict[str, list[float]]] = {}
    for v in decided:
        z = v["top_zone"] or "ไม่ระบุโซน"
        bucket = zone_buckets.setdefault(z, {"won": [], "lost": []})
        bucket["won" if v["deal_status"] == WON else "lost"].append(v["duration"] or 0)

    zone_by_outcome = []
    for z, b in zone_buckets.items():
        won_avg = sum(b["won"]) / len(b["won"]) if b["won"] else None
        lost_avg = sum(b["lost"]) / len(b["lost"]) if b["lost"] else None
        delta = (won_avg - lost_avg) if (won_avg is not None and lost_avg is not None) else None
        zone_by_outcome.append({
            "zone": z, "won_avg": won_avg, "lost_avg": lost_avg,
            "delta": delta, "total": len(b["won"]) + len(b["lost"]),
        })
    zone_by_outcome.sort(key=lambda z: -z["total"])

    people: dict[str, dict[str, Any]] = {}
    for v in visits:
        emp = v["employee_id"] or "—"
        entry = people.setdefault(emp, {
            "employee_id": emp, "name": v["sale_name"] or emp,
            "visits": 0, "decided": 0, "won": 0, "_durs": [],
        })
        entry["visits"] += 1
        if v["duration"] is not None:
            entry["_durs"].append(v["duration"])
        if v["deal_status"] in (WON, LOST):
            entry["decided"] += 1
            if v["deal_status"] == WON:
                entry["won"] += 1

    by_person = []
    for entry in people.values():
        durs = entry.pop("_durs")
        entry["avg_duration"] = (sum(durs) / len(durs)) if durs else None
        entry["close_rate"] = (100 * entry["won"] / entry["decided"]) if entry["decided"] else None
        by_person.append(entry)
    by_person.sort(key=lambda p: -p["visits"])

    by_hour = [{"hour": h, "visits": 0} for h in range(24)]
    by_weekday = [{"day": d, "visits": 0} for d in range(7)]
    for v in visits:
        if v["start_ts"] is None:
            continue
        dt = datetime.fromtimestamp(v["start_ts"], tz=timezone.utc)
        by_hour[dt.hour]["visits"] += 1
        by_weekday[dt.weekday()]["visits"] += 1

    return {
        "ok": True,
        "n_visits": n_visits,
        "decided": len(decided),
        "won": len(won),
        "lost": len(lost),
        "unlabelled": unlabelled,
        "close_rate": close_rate,
        "avg_duration": avg_duration,
        "enough_data": len(decided) >= MIN_FOR_TREND,
        "min_for_trend": MIN_FOR_TREND,
        "funnel": funnel,
        "duration_by_outcome": duration_by_outcome,
        "zone_by_outcome": zone_by_outcome[:6],
        "by_person": by_person,
        "by_hour": by_hour,
        "by_weekday": by_weekday,
    }


# ---------------------------------------------------------------------
# Tracking policy support (mock/simulation vs physical/hardware)
# ---------------------------------------------------------------------

def get_project_tracking_mode(project_id: str) -> str | None:
    row = db.fetchone("SELECT tracking_mode FROM projects WHERE id = %s", (project_id,))
    return row["tracking_mode"] if row else None


def get_active_plan(project_id: str) -> dict[str, Any] | None:
    return db.fetchone(
        """
        SELECT id AS plan_id, project_id, name, width_m, height_m, is_active
        FROM plans
        WHERE project_id = %s
        ORDER BY is_active DESC, id DESC
        LIMIT 1
        """,
        (project_id,),
    )


def get_tracking_tag(tag_id: str) -> dict[str, Any] | None:
    """Small tag record used by ingest policy checks."""
    return db.fetchone(
        """
        SELECT tag_id, employee_id, project_id, tag_type, status, x, y, battery, last_ts
        FROM tags
        WHERE tag_id = %s
        """,
        (tag_id,),
    )


def get_position_by_message_id(gateway_id: str, message_id: str) -> dict[str, Any] | None:
    # positions has no gateway_id column here; real hardware fixes dedupe
    # through hardware_ingest_receipts(device_id, message_id) on the
    # existing /api/hardware/ingest path instead. Only the simulator reaches
    # this function, and it never sets message_id, so this is always a miss.
    if not message_id:
        return None
    return db.fetchone(
        """
        SELECT tag_id, project_id, plan_id, x, y, zone, source, ts
        FROM positions
        WHERE device_id = %s AND message_id = %s
        """,
        (gateway_id, message_id),
    )


def record_position_fix(
    *,
    tag_id: str,
    employee_id: str | None,
    project_id: str,
    plan_id: str | None,
    x: float,
    y: float,
    zone: str | None,
    source: str,
    gateway_id: str | None,
    message_id: str | None,
    device_ts: datetime | None,
    residual_m: float | None,
    anchors_used: int | None,
    battery: float | None,
    ts: datetime,
    visit_key: str,
) -> dict[str, Any] | None:
    """Persist a fix, live tag state, and a newly opened visit.

    positions/visits here have no gateway_id, device_ts or visits.source
    columns, and no dedupe index on this path (that lives on
    hardware_ingest_receipts instead). This function is only ever reached
    from the simulator, which never repeats a message_id, so it is a plain
    insert with no ON CONFLICT. ``device_ts`` is accepted for interface
    compatibility with ``tracking.ingest_fix`` but not persisted.
    """
    return db.fetchone(
        """
        WITH inserted_position AS (
            INSERT INTO positions (
                tag_id, project_id, plan_id, x, y, zone, source,
                device_id, message_id, residual_m, anchors_used, ts
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING *
        ), updated_tag AS (
            UPDATE tags AS t
            SET x = p.x,
                y = p.y,
                battery = COALESCE(%s, t.battery),
                last_ts = p.ts
            FROM inserted_position AS p
            WHERE t.tag_id = p.tag_id
              AND (t.last_ts IS NULL OR t.last_ts <= p.ts)
            RETURNING t.tag_id
        ), opened_visit AS (
            INSERT INTO visits (
                visit_key, tag_id, employee_id, project_id, plan_id,
                started_at, deal_status
            )
            SELECT %s, p.tag_id, %s, p.project_id, p.plan_id, p.ts, ''
            FROM inserted_position AS p
            WHERE NOT EXISTS (
                SELECT 1 FROM visits AS v
                WHERE v.tag_id = p.tag_id AND v.ended_at IS NULL
            )
            RETURNING visit_key
        )
        SELECT p.*, (SELECT visit_key FROM opened_visit) AS opened_visit_key
        FROM inserted_position AS p
        """,
        (
            tag_id, project_id, plan_id, x, y, zone, source,
            gateway_id, message_id, residual_m, anchors_used, ts,
            battery,
            visit_key, employee_id,
        ),
    )
