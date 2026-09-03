from __future__ import annotations

import asyncio
import hashlib
import math
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from psycopg2.errors import ForeignKeyViolation, UniqueViolation
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

import calculations
import positioning
import queries as q
import tracking
from config import settings
from db import db, init_db, seed_demo_data
from live_hub import LiveHub, session_token_from_protocol_header
from security import create_token, password_verify, public_user
from simulator import simulator
from utils import utc_now


live_hub = LiveHub(lambda: q.get_live_tags(rows=0), interval=0.25)

app = FastAPI(
    title=settings.app_name,
    version="2.0.0",
    description="Backend API for the SUPALAI UWB tracking dashboard.",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------

NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]

# Identifiers travel in URLs, gateway configuration files and hardware labels,
# so they are restricted to characters that survive all three unescaped.
IdentifierText = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
)]
HardwareUidText = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
)]
MessageIdText = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
)]

TagType = Literal["physical", "mock"]
TagStatus = Literal["active", "disabled"]
TrackingMode = Literal["hardware", "simulation", "disabled"]


class PlanEditorModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class SignInRequest(BaseModel):
    email: str
    password: str


class GoogleSignInRequest(BaseModel):
    credential: str


class ProjectCreate(BaseModel):
    project_id: str
    name: str
    province: str = ""
    plan_id: str = ""
    plan_name: str = ""
    width_m: float = 20.0
    height_m: float = 20.0
    tracking_mode: TrackingMode = "simulation"


class TrackingModeUpdate(BaseModel):
    tracking_mode: TrackingMode


class AnchorCreate(BaseModel):
    anchor_id: str
    x: float
    y: float
    battery: float | None = None


class PlanCreate(PlanEditorModel):
    plan_id: NonEmptyText
    name: NonEmptyText
    width_m: float = Field(default=20.0, gt=0)
    height_m: float = Field(default=20.0, gt=0)
    is_active: bool = True
    version: int = Field(default=1, ge=1)


class PlanUpdate(PlanEditorModel):
    name: NonEmptyText | None = None
    width_m: float | None = Field(default=None, gt=0)
    height_m: float | None = Field(default=None, gt=0)
    is_active: bool | None = None
    version: int | None = Field(default=None, ge=1)


class PlanObjectCreate(PlanEditorModel):
    object_type: NonEmptyText
    label: str | None = None
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class PlanObjectUpdate(PlanEditorModel):
    object_type: NonEmptyText | None = None
    label: str | None = None
    geometry: dict[str, Any] | None = None
    properties: dict[str, Any] | None = None


class PlanZoneCreate(PlanEditorModel):
    name: NonEmptyText
    geometry: dict[str, Any] | None = None
    x_min: float | None = None
    x_max: float | None = None
    y_min: float | None = None
    y_max: float | None = None


class PlanAnchorCreate(PlanEditorModel):
    anchor_id: NonEmptyText
    x: float
    y: float
    z: float | None = None
    mount_height_m: float | None = Field(default=None, ge=0)
    battery: float | None = None


class PlanDimensionCreate(PlanEditorModel):
    x1: float
    y1: float
    x2: float
    y2: float
    length_m: float | None = Field(default=None, ge=0)
    angle_deg: float | None = None
    label: str | None = None


class VisitMeta(BaseModel):
    visit_key: str
    customer_id: str = ""
    deal_status: str = ""


class NoteCreate(BaseModel):
    visit_key: str
    body: str = Field(min_length=1, max_length=2000)


class TagCreate(BaseModel):
    tag_id: IdentifierText
    label: str = Field(default="", max_length=200)
    hardware_uid: HardwareUidText | None = None
    tag_type: TagType = "physical"
    status: TagStatus = "active"
    project_id: IdentifierText | None = None
    employee_id: IdentifierText | None = None


class TagUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=200)
    hardware_uid: HardwareUidText | None = None
    tag_type: TagType | None = None
    status: TagStatus | None = None


class TagAssign(BaseModel):
    project_id: IdentifierText
    employee_id: IdentifierText | None = None


class GatewayCreate(BaseModel):
    gateway_id: IdentifierText | None = None


class RangeMeasurement(BaseModel):
    anchor_id: str
    distance_m: float


class PositioningIngest(BaseModel):
    tag_id: str
    ranges: list[RangeMeasurement]


class HardwareIngest(BaseModel):
    """One fix from a real gateway.

    Either ``ranges`` (this API solves the position) or ``x``/``y`` (the
    gateway solved it on-device) must be present. ``message_id`` makes a
    retry after a lost response idempotent instead of duplicating the fix.
    """
    model_config = ConfigDict(allow_inf_nan=False)

    message_id: MessageIdText
    tag_id: IdentifierText | None = None
    hardware_uid: HardwareUidText | None = None
    project_id: IdentifierText | None = None
    device_ts: datetime | None = None
    ranges: list[RangeMeasurement] = Field(default_factory=list, max_length=32)
    x: float | None = None
    y: float | None = None
    residual_m: float | None = Field(default=None, ge=0)
    anchors_used: int | None = Field(default=None, ge=0)
    battery: float | None = Field(default=None, ge=0, le=100)


# ---------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------

def current_user(x_session: str | None) -> dict[str, Any] | None:
    if not x_session:
        return None
    user_id = q.get_session_user(x_session)
    if not user_id:
        return None
    return q.get_user_by_id(user_id)


def require_user(x_session: str | None) -> dict[str, Any]:
    user = current_user(x_session)
    if not user:
        raise HTTPException(status_code=401, detail="กรุณาเข้าสู่ระบบ")
    return user


def require_role(x_session: str | None, roles: set[str]) -> dict[str, Any]:
    user = require_user(x_session)
    if user["role"] not in roles:
        raise HTTPException(status_code=403, detail="ไม่มีสิทธิ์เข้าถึงข้อมูลนี้")
    return user


def require_plan(plan_id: str) -> dict[str, Any]:
    plan = q.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return plan


def require_project(project_id: str) -> dict[str, Any]:
    project = q.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    return project


# ---------------------------------------------------------------------
# Tag registry helpers
# ---------------------------------------------------------------------

def require_tag(tag_id: str) -> dict[str, Any]:
    tag = q.get_tag(tag_id)
    if not tag:
        raise HTTPException(status_code=404, detail="ไม่พบแท็ก")
    return tag


def require_assignable_project(project_id: str, tag_type: str) -> dict[str, Any]:
    """Check a project can hold a tag of this type before assigning it.

    A physical tag switches its project to hardware mode (the data layer does
    that in the same statement as the assignment), so only the reverse pairing
    is rejected: a mock tag would have the simulator moving it inside a project
    whose real hardware is reporting the same floor.
    """
    project = require_project(project_id)
    mode = project["tracking_mode"]
    if mode == "disabled":
        raise HTTPException(status_code=409, detail="โครงการนี้ปิดการติดตามอยู่")
    if tag_type == "mock" and mode == "hardware":
        raise HTTPException(status_code=409, detail="แท็กจำลองใช้กับโครงการโหมดใช้งานจริงไม่ได้")
    return project


def require_employee(employee_id: str | None) -> None:
    if employee_id and not q.get_user_by_employee_id(employee_id):
        raise HTTPException(status_code=404, detail="ไม่พบพนักงานรหัสนี้")


def _hash_gateway_key(gateway_key: str) -> str:
    return hashlib.sha256(gateway_key.encode("utf-8")).hexdigest()


# A fix from the future means a broken clock; a very old one is a replay or a
# queue that has been offline for hours. Neither describes a live position.
MAX_CLOCK_SKEW = timedelta(minutes=5)
MAX_MESSAGE_AGE = timedelta(minutes=15)


def hardware_device_ts(device_ts: datetime | None) -> datetime:
    if device_ts is None:
        return utc_now()
    if device_ts.tzinfo is None:
        device_ts = device_ts.replace(tzinfo=timezone.utc)
    skew = device_ts - utc_now()
    if skew > MAX_CLOCK_SKEW:
        raise HTTPException(status_code=422, detail="device_ts อยู่ในอนาคต")
    if -skew > MAX_MESSAGE_AGE:
        raise HTTPException(status_code=422, detail="device_ts เก่าเกินกว่าจะรับเป็นตำแหน่งปัจจุบัน")
    return device_ts


def project_anchor_positions(project: dict[str, Any]) -> dict[str, tuple[float, float]]:
    """Anchors of the project's active plan, or every anchor it has.

    Anchors were project-scoped before the plan editor existed, so a survey
    that has not been migrated to a plan still resolves positions.
    """
    plan_id = project.get("plan_id") or ""
    anchors = q.get_plan_anchors(plan_id) if plan_id else []
    if not anchors:
        anchors = project.get("anchors") or q.get_anchors(project["project_id"])
    return {anchor["anchor_id"]: (anchor["x"], anchor["y"]) for anchor in anchors}


def solve_ranges(
    project: dict[str, Any], ranges: list[RangeMeasurement],
) -> tuple[positioning.Fix, list[str]]:
    """Multilaterate one report, ignoring anchors this project does not know."""
    anchor_by_id = project_anchor_positions(project)
    used: list[str] = []
    known: list[tuple[tuple[float, float], float]] = []
    for measurement in ranges:
        anchor_id = measurement.anchor_id.strip()
        if anchor_id in used or anchor_id not in anchor_by_id:
            continue
        if not math.isfinite(measurement.distance_m) or measurement.distance_m <= 0:
            continue
        used.append(anchor_id)
        known.append((anchor_by_id[anchor_id], measurement.distance_m))

    if len(known) < 3:
        raise HTTPException(
            status_code=400,
            detail=f"ต้องมีระยะจาก anchor ที่รู้จักในโครงการนี้อย่างน้อย 3 จุด (ใช้ได้ {len(known)})",
        )
    fix = positioning.trilaterate([position for position, _d in known], [d for _p, d in known])
    if fix is None:
        raise HTTPException(status_code=422, detail="คำนวณตำแหน่งไม่สำเร็จ (ระยะที่ได้อาจไม่สอดคล้องกัน)")
    return fix, used


def tracking_error_status(error: tracking.TrackingPolicyError) -> int:
    """Map an ingest policy rejection onto the HTTP status it deserves."""
    if isinstance(error, tracking.UnknownTagError):
        return 404
    if isinstance(error, (tracking.TagSourceMismatchError, tracking.InactiveTagError)):
        return 403
    if isinstance(error, (tracking.TagProjectMismatchError, tracking.ProjectModeMismatchError)):
        return 409
    return 422


def normalise_zone(payload: PlanZoneCreate) -> dict[str, Any]:
    data = payload.model_dump()
    geometry = data.get("geometry")

    if geometry is not None:
        points = geometry.get("points")
        if not isinstance(points, list) or len(points) < 3:
            raise HTTPException(status_code=422, detail="geometry.points ต้องมีอย่างน้อย 3 จุด")

        coordinates: list[tuple[float, float]] = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                raise HTTPException(status_code=422, detail="แต่ละจุดใน geometry.points ต้องเป็น [x, y]")
            x, y = point[0], point[1]
            if (
                isinstance(x, bool) or isinstance(y, bool)
                or not isinstance(x, (int, float)) or not isinstance(y, (int, float))
                or not math.isfinite(float(x)) or not math.isfinite(float(y))
            ):
                raise HTTPException(status_code=422, detail="พิกัด geometry ต้องเป็นตัวเลขที่มีค่าจำกัด")
            coordinates.append((float(x), float(y)))

        data["x_min"] = min(x for x, _y in coordinates)
        data["x_max"] = max(x for x, _y in coordinates)
        data["y_min"] = min(y for _x, y in coordinates)
        data["y_max"] = max(y for _x, y in coordinates)
    else:
        bounds = (data.get("x_min"), data.get("x_max"), data.get("y_min"), data.get("y_max"))
        if any(value is None for value in bounds):
            raise HTTPException(
                status_code=422,
                detail="ต้องระบุ geometry หรือ x_min, x_max, y_min, y_max ให้ครบ",
            )
        data["geometry"] = {
            "type": "polygon",
            "points": [
                [data["x_min"], data["y_min"]],
                [data["x_max"], data["y_min"]],
                [data["x_max"], data["y_max"]],
                [data["x_min"], data["y_max"]],
            ],
        }

    if data["x_min"] >= data["x_max"] or data["y_min"] >= data["y_max"]:
        raise HTTPException(status_code=422, detail="ขอบเขต zone ต้องมีความกว้างและความสูงมากกว่า 0")
    return data


def normalise_dimension(payload: PlanDimensionCreate) -> dict[str, Any]:
    data = payload.model_dump()
    dx = payload.x2 - payload.x1
    dy = payload.y2 - payload.y1
    if data["length_m"] is None:
        data["length_m"] = math.hypot(dx, dy)
    if data["angle_deg"] is None:
        data["angle_deg"] = math.degrees(math.atan2(dy, dx))
    return data


def _query_params(province, project, plan, employee, customer, from_date, to_date) -> dict[str, str]:
    return {
        "province": province or "", "project": project or "", "plan": plan or "",
        "employee": employee or "", "customer": customer or "",
        "from": from_date or "", "to": to_date or "",
    }


# ---------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------

@app.on_event("startup")
async def startup() -> None:
    init_db()
    seed_demo_data()
    live_hub.start()
    if settings.simulator_enabled:
        simulator.start()


@app.on_event("shutdown")
async def shutdown() -> None:
    simulator.stop()
    await live_hub.stop()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "supalai-tracking-api",
        "database": "postgres",
        "simulator": settings.simulator_enabled,
        "time": utc_now().isoformat(),
    }


# ---------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------

@app.get("/api/auth/google-config")
def google_config():
    enabled = bool(settings.google_client_id)
    return {"enabled": enabled, "client_id": settings.google_client_id if enabled else None}


@app.post("/api/signin")
def signin(payload: SignInRequest):
    user = q.get_user_by_email(payload.email.strip().lower())
    if not user or not password_verify(payload.password, user["password_hash"]):
        return {"ok": False, "error": "Email หรือ Password ไม่ถูกต้อง"}
    token = create_token(user["id"])
    return {"ok": True, "token": token, "user": public_user(user)}


@app.post("/api/signout")
def signout(x_session: str | None = Header(default=None)):
    if x_session:
        q.delete_session(x_session)
    return {"ok": True}


@app.post("/api/google-signin")
def google_signin(payload: GoogleSignInRequest):
    if not settings.google_client_id:
        return {"ok": False, "error": "Google Sign-In ยังไม่ได้ตั้งค่าใน .env"}
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        info = id_token.verify_oauth2_token(payload.credential, google_requests.Request(), settings.google_client_id)
        email = str(info.get("email", "")).lower().strip()
        if not email:
            return {"ok": False, "error": "Google ไม่ส่ง email กลับมา"}

        user = q.get_user_by_email(email)
        if not user:
            return {"ok": False, "error": "ไม่พบ email นี้ในระบบ SUPALAI"}

        token = create_token(user["id"])
        return {"ok": True, "token": token, "user": public_user(user)}
    except ImportError:
        return {"ok": False, "error": "ยังไม่ได้ติดตั้ง google-auth"}
    except Exception as exc:
        return {"ok": False, "error": f"Google authentication failed: {exc}"}


@app.get("/api/me")
def me(x_session: str | None = Header(default=None)):
    """Restores the session after a page refresh / direct navigation.

    Without this endpoint the frontend's route() guard (which calls it on
    every navigation when S.user isn't already in memory) always fails and
    bounces the person back to login.html, even with a valid token.
    """
    user = require_user(x_session)
    return {"ok": True, "user": public_user(user)}


# ---------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------

@app.get("/api/bootstrap")
def bootstrap(x_session: str | None = Header(default=None)):
    user = require_user(x_session)

    projects = q.get_projects()
    people = [
        {
            "employee_id": p["employee_id"], "first_en": p["first_en"], "last_en": p["last_en"],
            "first_th": p["first_th"], "last_th": p["last_th"], "role": p["role"],
            "position": p["position"], "tag_id": p.get("tag_id"),
        }
        for p in q.all_users()
    ]
    customers = db.fetchall("SELECT id, name FROM customers ORDER BY name")

    live_project = next(
        (project for project in projects if any(plan.get("live") for plan in project.get("plans", []))),
        projects[0] if projects else None,
    )
    live_id = live_project["project_id"] if live_project else None
    live_plan = next(
        (plan for plan in (live_project or {}).get("plans", []) if plan.get("live")),
        ((live_project or {}).get("plans") or [None])[0],
    )
    live_plan_id = live_plan.get("plan_id") if live_plan else None
    zones_rows = q.get_plan_zones(live_plan_id) if live_plan_id else (q.get_zones(live_id) if live_id else [])
    zones = [{"name": z["name"], "x": [z["x_min"], z["x_max"]], "y": [z["y_min"], z["y_max"]]} for z in zones_rows]
    anchors_rows = q.get_plan_anchors(live_plan_id) if live_plan_id else (q.get_anchors(live_id) if live_id else [])
    anchors = {a["anchor_id"]: [a["x"], a["y"]] for a in anchors_rows}

    return {
        "ok": True,
        "user": public_user(user),
        "projects": projects,
        "people": people,
        "customers": customers,
        "zones": zones,
        "anchors": anchors,
        "live_project_id": live_id,
        "live_plan_id": live_plan_id,
        "deal_statuses": q.DEAL_STATUSES,
    }


# ---------------------------------------------------------------------
# Overview / devices / live
# ---------------------------------------------------------------------

@app.get("/api/overview")
def overview(
    x_session: str | None = Header(default=None),
    province: str | None = None, project: str | None = None, plan: str | None = None,
    employee: str | None = None, customer: str | None = None,
    from_: str | None = Query(default=None, alias="from"), to: str | None = None,
):
    user = require_user(x_session)
    q_params = _query_params(province, project, plan, employee, customer, from_, to)
    q_params, scope = q.apply_scope(q_params, user)
    result = q.get_overview(q_params)
    result["scope"] = scope
    return result


@app.get("/api/devices")
def devices(x_session: str | None = Header(default=None), project_id: str | None = None):
    require_user(x_session)
    return {
        "ok": True,
        "anchors": q.get_anchors(project_id),
        "tags": q.get_tags(project_id),
    }


@app.get("/api/live")
def live(
    x_session: str | None = Header(default=None),
    since: float = 0,
    rows: int = 400,
    project_id: str | None = None,
):
    require_user(x_session)
    return q.get_live_tags(rows=rows, since=since, project_id=project_id)


# ---------------------------------------------------------------------
# Tag registry — physical hardware vs. simulated demo tags
# ---------------------------------------------------------------------

@app.get("/api/tags")
def tags_list(x_session: str | None = Header(default=None), project_id: str | None = None):
    require_user(x_session)
    return {"ok": True, "tags": q.get_tags(project_id)}


@app.post("/api/tags", status_code=201)
def tag_create(payload: TagCreate, x_session: str | None = Header(default=None)):
    """Register a tag and, when a project is named, assign it there at once."""
    user = require_role(x_session, {"admin"})
    if q.get_tag(payload.tag_id):
        raise HTTPException(status_code=409, detail="Tag ID นี้มีอยู่แล้ว")

    require_employee(payload.employee_id)
    if payload.project_id:
        require_assignable_project(payload.project_id, payload.tag_type)

    data = payload.model_dump()
    data["label"] = payload.label.strip() or payload.tag_id
    try:
        tag = q.create_tag(data, assigned_by=user["id"])
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="Tag ID หรือ Hardware UID ซ้ำกับแท็กอื่น") from exc
    except ForeignKeyViolation as exc:
        raise HTTPException(status_code=409, detail="โครงการหรือพนักงานที่อ้างถึงไม่มีอยู่") from exc
    if not tag:
        raise HTTPException(status_code=409, detail="ลงทะเบียนแท็กไม่สำเร็จ")
    return {"ok": True, "tag": tag}


@app.get("/api/tags/{tag_id}")
def tag_detail(tag_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    return {"ok": True, "tag": require_tag(tag_id)}


@app.patch("/api/tags/{tag_id}")
def tag_update(tag_id: str, payload: TagUpdate, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    existing = require_tag(tag_id)

    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="ไม่มีข้อมูลสำหรับแก้ไขแท็ก")
    if "label" in data:
        data["label"] = (data["label"] or "").strip() or tag_id
    if data.get("tag_type") and existing["project_id"]:
        require_assignable_project(existing["project_id"], data["tag_type"])

    try:
        tag = q.update_tag(tag_id, data)
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="Hardware UID ซ้ำกับแท็กอื่น") from exc
    return {"ok": True, "tag": tag}


@app.post("/api/tags/{tag_id}/assign")
def tag_assign(tag_id: str, payload: TagAssign, x_session: str | None = Header(default=None)):
    """Move a tag to another project or hand it to another employee.

    The previous assignment is ended rather than overwritten, and any visit
    still open on the old project is closed, so history stays attributed to
    where it was actually recorded.
    """
    user = require_role(x_session, {"admin"})
    existing = require_tag(tag_id)
    require_assignable_project(payload.project_id, existing["tag_type"])
    require_employee(payload.employee_id)

    try:
        tag = q.assign_tag(tag_id, payload.project_id, payload.employee_id, assigned_by=user["id"])
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="แท็กนี้มีการมอบหมายที่ยังใช้งานอยู่") from exc
    if not tag:
        raise HTTPException(status_code=409, detail="ย้ายโครงการไม่สำเร็จ")
    return {"ok": True, "tag": tag}


@app.post("/api/tags/{tag_id}/deactivate")
def tag_deactivate(tag_id: str, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    require_tag(tag_id)
    return {"ok": True, "tag": q.deactivate_tag(tag_id)}


def websocket_session_token(websocket: WebSocket) -> str | None:
    """Read the existing session token from the browser WebSocket protocols."""
    return session_token_from_protocol_header(websocket.headers.get("sec-websocket-protocol", ""))


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    token = websocket_session_token(websocket)
    user = await asyncio.to_thread(current_user, token)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid or expired session")
        return

    try:
        await live_hub.connect(websocket)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await live_hub.disconnect(websocket)


# ---------------------------------------------------------------------
# Visits / analytics
# ---------------------------------------------------------------------

@app.get("/api/visits")
def visits(
    x_session: str | None = Header(default=None),
    province: str | None = None, project: str | None = None, plan: str | None = None,
    employee: str | None = None, customer: str | None = None,
    from_: str | None = Query(default=None, alias="from"), to: str | None = None,
):
    user = require_user(x_session)
    q_params = _query_params(province, project, plan, employee, customer, from_, to)
    q_params, scope = q.apply_scope(q_params, user)
    return {"ok": True, "visits": q.get_visits(q_params), "scope": scope}


@app.get("/api/visit")
def visit_detail(key: str, x_session: str | None = Header(default=None)):
    user = require_user(x_session)
    result = q.get_visit(key)
    if not result:
        return {"error": "ไม่พบข้อมูลการเยี่ยมชม"}

    if user["role"] == "sale" and result["employee_id"] != user["employee_id"]:
        return {"error": "ไม่มีสิทธิ์ดูข้อมูลนี้"}

    result["viewer_role"] = user["role"]
    result["can_edit"] = user["role"] in {"admin", "sale_lead"}
    return result


@app.get("/api/heatmap")
def heatmap(
    x_session: str | None = Header(default=None),
    province: str | None = None, project: str | None = None, plan: str | None = None,
    employee: str | None = None, customer: str | None = None,
    from_: str | None = Query(default=None, alias="from"), to: str | None = None,
):
    user = require_user(x_session)
    q_params = _query_params(province, project, plan, employee, customer, from_, to)
    q_params, _scope = q.apply_scope(q_params, user)
    return q.get_heatmap(q_params)


@app.get("/api/analytics")
def analytics(
    x_session: str | None = Header(default=None),
    province: str | None = None, project: str | None = None, plan: str | None = None,
    employee: str | None = None, customer: str | None = None,
    from_: str | None = Query(default=None, alias="from"), to: str | None = None,
):
    require_role(x_session, {"admin", "sale_lead"})
    q_params = _query_params(province, project, plan, employee, customer, from_, to)
    return q.get_analytics(q_params)


@app.post("/api/visit-meta")
def visit_meta(payload: VisitMeta, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin", "sale_lead"})
    row = db.fetchone("SELECT id FROM visits WHERE visit_key = %s", (payload.visit_key,))
    if not row:
        return {"ok": False, "error": "ไม่พบ visit"}
    q.set_visit_meta(payload.visit_key, payload.customer_id, payload.deal_status)
    return {"ok": True}


@app.post("/api/note")
def add_note(payload: NoteCreate, x_session: str | None = Header(default=None)):
    user = require_user(x_session)
    visit = q.get_visit(payload.visit_key)
    if not visit:
        return {"ok": False, "error": "ไม่พบ visit"}
    if user["role"] == "sale" and visit["employee_id"] != user["employee_id"]:
        return {"ok": False, "error": "ไม่มีสิทธิ์แก้ไขข้อมูลนี้"}
    q.add_note(payload.visit_key, user["id"], payload.body.strip())
    return {"ok": True}


# ---------------------------------------------------------------------
# Projects / anchors
# ---------------------------------------------------------------------

@app.post("/api/projects")
def project_create(payload: ProjectCreate, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    return q.create_project(payload.model_dump())


@app.get("/api/projects")
def projects(x_session: str | None = Header(default=None)):
    require_user(x_session)
    return {"ok": True, "projects": q.get_projects()}


@app.get("/api/projects/{project_id}/plans")
def project_plans(project_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    if not q.get_project(project_id):
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    return {"ok": True, "plans": q.get_plans(project_id)}


@app.post("/api/projects/{project_id}/plans")
def plan_create(project_id: str, payload: PlanCreate, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    if not q.get_project(project_id):
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    plan = q.create_plan(project_id, payload.model_dump())
    if not plan:
        raise HTTPException(status_code=409, detail="plan_id หรือชื่อแปลนซ้ำในโครงการ")
    return {"ok": True, "plan": plan}


@app.get("/api/projects/{project_id}")
def project_detail(project_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    return require_project(project_id)


@app.post("/api/projects/{project_id}/tracking-mode")
def project_tracking_mode(
    project_id: str, payload: TrackingModeUpdate, x_session: str | None = Header(default=None),
):
    """Switch a project between real hardware, the simulator, and off.

    Leaving hardware mode while physical tags are still assigned would hand
    those tags to the simulator, so the tags have to be moved or disabled
    first.
    """
    require_role(x_session, {"admin"})
    require_project(project_id)

    if payload.tracking_mode != "hardware":
        physical = [
            tag for tag in q.get_tags(project_id)
            if tag["tag_type"] == "physical" and tag["status"] == "active"
        ]
        if physical:
            raise HTTPException(
                status_code=409,
                detail="ยังมีแท็กอุปกรณ์จริงในโครงการนี้ กรุณาย้ายหรือปิดใช้งานก่อน "
                       f"({', '.join(tag['tag_id'] for tag in physical)})",
            )

    project = q.set_project_tracking_mode(project_id, payload.tracking_mode)
    return {"ok": True, "project": project}


# ---------------------------------------------------------------------
# Gateway credentials
# ---------------------------------------------------------------------

@app.get("/api/projects/{project_id}/gateways")
def project_gateways(project_id: str, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    require_project(project_id)
    return {"ok": True, "gateways": q.get_project_gateways(project_id)}


@app.post("/api/projects/{project_id}/gateways", status_code=201)
def gateway_create(
    project_id: str, payload: GatewayCreate, x_session: str | None = Header(default=None),
):
    """Issue one gateway key for a project.

    The key is returned exactly once and only its SHA-256 digest is stored, so
    a leaked database dump cannot be replayed against the ingest endpoint. A
    lost key is replaced by revoking the gateway and creating a new one.
    """
    require_role(x_session, {"admin"})
    require_project(project_id)

    gateway_id = payload.gateway_id or f"GW-{secrets.token_hex(4).upper()}"
    gateway_key = secrets.token_urlsafe(32)
    try:
        gateway = q.create_gateway_credential(project_id, gateway_id, _hash_gateway_key(gateway_key))
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="Gateway ID นี้มีอยู่แล้ว") from exc
    if not gateway:
        raise HTTPException(status_code=409, detail="สร้าง Gateway ไม่สำเร็จ")
    return {
        "ok": True,
        "gateway": gateway,
        "gateway_key": gateway_key,
        "warning": "คัดลอก Key นี้ทันที ระบบจะไม่แสดงอีก",
    }


@app.post("/api/projects/{project_id}/gateways/{gateway_id}/revoke")
def gateway_revoke(
    project_id: str, gateway_id: str, x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    gateway = q.revoke_gateway(project_id, gateway_id)
    if not gateway:
        raise HTTPException(status_code=404, detail="ไม่พบ Gateway นี้ในโครงการ")
    return {"ok": True, "gateway": gateway}


@app.get("/api/plans/{plan_id}")
def plan_detail(plan_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    return {"ok": True, "plan": require_plan(plan_id)}


@app.put("/api/plans/{plan_id}")
def plan_update(plan_id: str, payload: PlanUpdate, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    data = {
        key: value
        for key, value in payload.model_dump(exclude_unset=True).items()
        if value is not None
    }
    if not data:
        raise HTTPException(status_code=400, detail="ไม่มีข้อมูลสำหรับแก้ไขแปลน")
    try:
        plan = q.update_plan(plan_id, data)
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="ชื่อแปลนซ้ำในโครงการ") from exc
    if not plan:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return {"ok": True, "plan": plan}


@app.get("/api/plans/{plan_id}/objects")
def plan_objects(plan_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    require_plan(plan_id)
    return {"ok": True, "objects": q.get_plan_objects(plan_id)}


@app.post("/api/plans/{plan_id}/objects")
def plan_object_create(
    plan_id: str,
    payload: PlanObjectCreate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    plan_object = q.create_plan_object(plan_id, payload.model_dump())
    if not plan_object:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return {"ok": True, "object": plan_object}


@app.put("/api/plans/{plan_id}/objects/{object_id}")
def plan_object_update(
    plan_id: str,
    object_id: int,
    payload: PlanObjectUpdate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(status_code=400, detail="ไม่มีข้อมูลสำหรับแก้ไข object")
    if any(data.get(key) is None for key in {"object_type", "geometry", "properties"} if key in data):
        raise HTTPException(status_code=422, detail="object_type, geometry และ properties ห้ามเป็น null")
    plan_object = q.update_plan_object(plan_id, object_id, data)
    if not plan_object:
        raise HTTPException(status_code=404, detail="ไม่พบ object ในแปลนนี้")
    return {"ok": True, "object": plan_object}


@app.delete("/api/plans/{plan_id}/objects/{object_id}")
def plan_object_delete(
    plan_id: str,
    object_id: int,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    if not q.delete_plan_object(plan_id, object_id):
        raise HTTPException(status_code=404, detail="ไม่พบ object ในแปลนนี้")
    return {"ok": True}


@app.get("/api/plans/{plan_id}/zones")
def plan_zones(plan_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    require_plan(plan_id)
    return {"ok": True, "zones": q.get_plan_zones(plan_id)}


@app.post("/api/plans/{plan_id}/zones")
def plan_zone_create(
    plan_id: str,
    payload: PlanZoneCreate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    try:
        zone = q.create_plan_zone(plan_id, normalise_zone(payload))
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="ชื่อ zone ซ้ำในโครงการ") from exc
    if not zone:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return {"ok": True, "zone": zone}


@app.get("/api/plans/{plan_id}/anchors")
def plan_anchors(plan_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    require_plan(plan_id)
    return {"ok": True, "anchors": q.get_plan_anchors(plan_id)}


@app.post("/api/plans/{plan_id}/anchors")
def plan_anchor_create(
    plan_id: str,
    payload: PlanAnchorCreate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    anchor = q.create_plan_anchor(plan_id, payload.model_dump())
    if not anchor:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return {"ok": True, "anchor": anchor}


@app.get("/api/plans/{plan_id}/dimensions")
def plan_dimensions(plan_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    require_plan(plan_id)
    return {"ok": True, "dimensions": q.get_plan_dimensions(plan_id)}


@app.post("/api/plans/{plan_id}/dimensions")
def plan_dimension_create(
    plan_id: str,
    payload: PlanDimensionCreate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    require_plan(plan_id)
    dimension = q.create_plan_dimension(plan_id, normalise_dimension(payload))
    if not dimension:
        raise HTTPException(status_code=404, detail="ไม่พบแปลน")
    return {"ok": True, "dimension": dimension}


@app.post("/api/projects/{project_id}/anchors")
def anchor_create(project_id: str, payload: AnchorCreate, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    if not q.get_project(project_id):
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    return q.create_anchor(project_id, payload.model_dump())


@app.get("/api/projects/{project_id}/anchors")
def project_anchors(project_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    if not q.get_project(project_id):
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    return {"ok": True, "anchors": q.get_anchors(project_id)}


# ---------------------------------------------------------------------
# Anchor placement / coverage — real geometry, not placeholders
# ---------------------------------------------------------------------

@app.post("/api/calculation/anchors")
def calculate_anchors(payload: dict[str, Any], x_session: str | None = Header(default=None)):
    require_user(x_session)

    width = float(payload.get("width_m", 20))
    height = float(payload.get("height_m", 20))
    margin = float(payload.get("margin_m", 1))
    radius = float(payload.get("coverage_radius_m", 12))

    anchors = calculations.suggest_anchor_layout(width, height, margin_m=margin, coverage_radius_m=radius)
    coverage = calculations.analyze_coverage(anchors, radius_m=radius, width_m=width, height_m=height)

    return {
        "ok": True,
        "input": payload,
        "suggested_anchors": anchors,
        "predicted_coverage": {k: v for k, v in coverage.items() if k not in ("gap_points", "gap_points_truncated")},
    }


@app.post("/api/calculation/coverage")
def calculate_coverage(payload: dict[str, Any], x_session: str | None = Header(default=None)):
    require_user(x_session)

    anchors = payload.get("anchors", [])
    radius = float(payload.get("coverage_radius_m", 10))
    width = float(payload.get("width_m", 20))
    height = float(payload.get("height_m", 20))
    resolution = payload.get("resolution_m")

    if not anchors:
        raise HTTPException(status_code=400, detail="ต้องระบุตำแหน่ง anchor อย่างน้อย 1 จุด")

    result = calculations.analyze_coverage(
        anchors, radius_m=radius, width_m=width, height_m=height,
        resolution_m=float(resolution) if resolution else None,
    )
    return {"ok": True, "coverage_radius_m": radius, "anchors": anchors, **result}


# ---------------------------------------------------------------------
# Positioning — real multilateration
# ---------------------------------------------------------------------

@app.get("/api/positioning/{project_id}")
def positioning_snapshot(project_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    require_project(project_id)
    live = q.get_live_tags(rows=0, project_id=project_id)
    return {"ok": True, "project_id": project_id, "tags": live.get("tags", {})}


@app.post("/api/positioning/{project_id}/ingest")
def positioning_ingest(project_id: str, payload: PositioningIngest, x_session: str | None = Header(default=None)):
    """Turn raw anchor-to-tag ranges into a fix for a *simulated* project.

    This path is authenticated as a dashboard admin, so it is the one to use
    for bench tests and demos: it accepts mock tags in a project whose
    tracking_mode is `simulation`. Real gateways have no session to sign in
    with and post to `/api/uwb/ingest` instead, where the project-scoped
    gateway key is the credential.
    """
    require_role(x_session, {"admin"})
    project = require_project(project_id)
    if project["tracking_mode"] != "simulation":
        raise HTTPException(
            status_code=403,
            detail="ปลายทางนี้รับเฉพาะโครงการโหมดจำลอง อุปกรณ์จริงต้องส่งผ่าน /api/uwb/ingest",
        )

    fix, _used = solve_ranges(project, payload.ranges)
    try:
        result = tracking.ingest_fix(
            payload.tag_id,
            fix.x,
            fix.y,
            project_id=project_id,
            source="simulator",
            residual_m=fix.residual_m,
            anchors_used=fix.anchors_used,
        )
    except tracking.TrackingPolicyError as exc:
        raise HTTPException(status_code=tracking_error_status(exc), detail=str(exc)) from exc

    return {
        "ok": True,
        "tag_id": payload.tag_id,
        "project_id": result["project_id"],
        "plan_id": result["plan_id"],
        "source": result["source"],
        "x": round(fix.x, 3),
        "y": round(fix.y, 3),
        "zone": result["zone"],
        "residual_m": fix.residual_m,
        "anchors_used": fix.anchors_used,
        "ts": result["ts"],
    }


@app.post("/api/uwb/ingest")
def uwb_ingest(
    payload: HardwareIngest,
    x_gateway_id: str | None = Header(default=None),
    x_gateway_key: str | None = Header(default=None),
):
    """Hardware ingest for real UWB gateways.

    A gateway is an unattended device, so it authenticates with the
    project-scoped key issued by `POST /api/projects/{id}/gateways` rather
    than a dashboard session. Only the key's SHA-256 digest is stored. The
    project comes from the credential, never from the request body, and
    `tracking.ingest_fix` enforces the physical-tag / hardware-project
    boundary before anything is written.
    """
    if not x_gateway_id or not x_gateway_key:
        raise HTTPException(status_code=401, detail="ต้องมี X-Gateway-Id และ X-Gateway-Key")

    credential = q.get_gateway_credential(x_gateway_id.strip())
    # An unknown gateway, a revoked one, and a wrong key all answer alike.
    if not credential or credential["status"] != "active":
        raise HTTPException(status_code=401, detail="Gateway ไม่ได้รับอนุญาต")
    project_id = credential["project_id"]
    if not q.gateway_key_is_valid(project_id, credential["gateway_id"], _hash_gateway_key(x_gateway_key)):
        raise HTTPException(status_code=401, detail="Gateway ไม่ได้รับอนุญาต")
    if payload.project_id and payload.project_id != project_id:
        raise HTTPException(status_code=403, detail="Gateway นี้ไม่ได้ผูกกับโครงการที่ระบุ")

    project = require_project(project_id)
    if project["tracking_mode"] != "hardware":
        raise HTTPException(status_code=409, detail=f"โครงการ {project_id} ไม่ได้อยู่ในโหมดใช้งานจริง")

    tag_id = payload.tag_id
    if not tag_id:
        if not payload.hardware_uid:
            raise HTTPException(status_code=422, detail="ต้องระบุ tag_id หรือ hardware_uid")
        tag = q.get_tag_by_hardware_uid(payload.hardware_uid)
        if not tag:
            raise HTTPException(status_code=404, detail="Hardware UID นี้ยังไม่ได้ลงทะเบียน")
        tag_id = tag["tag_id"]

    device_ts = hardware_device_ts(payload.device_ts)
    used: list[str] = []
    if payload.ranges:
        fix, used = solve_ranges(project, payload.ranges)
        x, y = fix.x, fix.y
        residual_m: float | None = fix.residual_m
        anchors_used: int | None = fix.anchors_used
    elif payload.x is None or payload.y is None:
        # A gateway that solves positions on-device may post the fix directly.
        raise HTTPException(status_code=422, detail="ต้องส่ง ranges หรือพิกัด x/y ที่คำนวณแล้ว")
    else:
        x, y = payload.x, payload.y
        residual_m, anchors_used = payload.residual_m, payload.anchors_used

    try:
        result = tracking.ingest_fix(
            tag_id,
            x,
            y,
            ts=device_ts,
            project_id=project_id,
            source="hardware",
            gateway_id=credential["gateway_id"],
            message_id=payload.message_id,
            device_ts=device_ts,
            residual_m=residual_m,
            anchors_used=anchors_used,
            battery=payload.battery,
        )
    except tracking.TrackingPolicyError as exc:
        raise HTTPException(status_code=tracking_error_status(exc), detail=str(exc)) from exc

    q.touch_gateway(credential["gateway_id"])
    # The anchors that produced this fix are demonstrably alive, so anchor
    # status follows the gateway instead of the simulator's heartbeat.
    if used and not result["duplicate"]:
        q.touch_anchor_ids(project_id, used)

    return {
        "ok": True,
        "duplicate": result["duplicate"],
        "tag_id": tag_id,
        "project_id": result["project_id"],
        "plan_id": result["plan_id"],
        "gateway_id": result["gateway_id"],
        "message_id": result["message_id"],
        "source": result["source"],
        "x": round(result["x"], 3),
        "y": round(result["y"], 3),
        "zone": result["zone"],
        "residual_m": residual_m,
        "anchors_used": anchors_used,
        "ts": result["ts"],
    }


# ---------------------------------------------------------------------
# Serve frontend
# ---------------------------------------------------------------------

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "SUPALAI-UWB-frontend"


@app.get("/", include_in_schema=False)
def frontend_index():
    index_file = FRONTEND_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": "SUPALAI API is running. Open /docs."}


@app.get("/login.html", include_in_schema=False)
def frontend_login():
    file = FRONTEND_DIR / "login.html"
    if file.exists():
        return FileResponse(file)
    raise HTTPException(status_code=404)


@app.get("/dashboard.html", include_in_schema=False)
def frontend_dashboard():
    file = FRONTEND_DIR / "dashboard.html"
    if file.exists():
        return FileResponse(file)
    raise HTTPException(status_code=404)


@app.get("/plan-editor.html", include_in_schema=False)
def frontend_plan_editor():
    file = FRONTEND_DIR / "plan-editor.html"
    if file.exists():
        return FileResponse(file)
    raise HTTPException(status_code=404)


try:
    from fastapi.staticfiles import StaticFiles

    if FRONTEND_DIR.exists():
        app.mount("/css", StaticFiles(directory=FRONTEND_DIR / "css"), name="css")
        app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")
        assets_dir = FRONTEND_DIR / "assets"
        if assets_dir.exists():
            app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
except Exception:
    pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=settings.host, port=settings.port, reload=settings.debug)
