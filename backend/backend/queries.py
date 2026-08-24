from __future__ import annotations

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


def all_users() -> list[dict[str, Any]]:
    return db.fetchall(
        """
        SELECT id, employee_id, email, role, position,
               first_th, last_th, first_en, last_en, tag_id, password_hash
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


# ---------------------------------------------------------------------
# Projects / zones / anchors / tags
# ---------------------------------------------------------------------

def get_projects() -> list[dict[str, Any]]:
    projects = db.fetchall(
        """
        SELECT id AS project_id, name, province, plan_id, plan_name, width_m, height_m
        FROM projects
        ORDER BY name
        """
    )
    for project in projects:
        project["plans"] = [{"plan_id": project["plan_id"], "name": project["plan_name"], "live": True}]
    return projects


def get_project(project_id: str) -> dict[str, Any] | None:
    for row in get_projects():
        if row["project_id"] == project_id:
            row["anchors"] = get_anchors(project_id)
            row["zones"] = get_zones(project_id)
            return row
    return None


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


def get_anchors(project_id: str | None = None) -> list[dict[str, Any]]:
    where = "WHERE project_id = %s" if project_id else ""
    params = (project_id,) if project_id else ()
    rows = db.fetchall(
        f"""
        SELECT anchor_id, project_id, x, y, battery, last_ts
        FROM anchors
        {where}
        ORDER BY anchor_id
        """,
        params,
    )
    now = utc_now()
    for a in rows:
        a["on"] = bool(a["last_ts"] and (now - a["last_ts"]).total_seconds() <= ANCHOR_ONLINE_SEC)
        a["last_ts"] = to_epoch(a["last_ts"])
    return rows


def touch_anchors(project_id: str) -> None:
    db.execute("UPDATE anchors SET last_ts = %s WHERE project_id = %s", (utc_now(), project_id))


def get_tags(project_id: str | None = None) -> list[dict[str, Any]]:
    where = "WHERE t.project_id = %s" if project_id else ""
    params = (project_id,) if project_id else ()
    rows = db.fetchall(
        f"""
        SELECT t.tag_id, t.project_id, t.x, t.y, t.battery, t.last_ts,
               u.first_en || ' ' || u.last_en AS sale_name
        FROM tags t
        LEFT JOIN users u ON u.employee_id = t.employee_id
        {where}
        ORDER BY t.tag_id
        """,
        params,
    )
    now = utc_now()
    for t in rows:
        t["on"] = bool(t["last_ts"] and (now - t["last_ts"]).total_seconds() <= TAG_ONLINE_SEC)
        t["last_ts"] = to_epoch(t["last_ts"])
    return rows


def get_live_tags(rows: int = 400, since: float = 0) -> dict[str, Any]:
    tags = get_tags()
    result = {
        t["tag_id"]: {
            "x": t["x"],
            "y": t["y"],
            "battery": t["battery"],
            "on": t["on"],
            "sale_name": t["sale_name"],
            "last_ts": t["last_ts"],
        }
        for t in tags
    }

    trail: list[dict[str, Any]] = []
    if rows > 0:
        since_dt = datetime.fromtimestamp(since, tz=timezone.utc) if since else None
        clause = "WHERE ts > %s" if since_dt else ""
        params = (since_dt,) if since_dt else ()
        trail_rows = db.fetchall(
            f"SELECT tag_id, x, y, zone, ts FROM positions {clause} ORDER BY ts DESC LIMIT %s",
            (*params, rows),
        )
        trail = [
            {"tag_id": r["tag_id"], "x": r["x"], "y": r["y"], "zone": r["zone"], "ts": to_epoch(r["ts"])}
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
