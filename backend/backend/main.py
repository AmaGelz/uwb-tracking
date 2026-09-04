from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import math
from pathlib import Path
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, Literal

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from psycopg2 import Error as DatabaseError
from psycopg2.errors import UniqueViolation
from psycopg2.extras import Json
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

import calculations
import positioning
import queries as q
import tracking
from config import settings
from db import db, init_db, seed_demo_data
from live_hub import LiveHub, session_token_from_protocol_header
from mailer import send_activation_email, send_password_reset_email
from security import (
    create_password_reset_token,
    create_token,
    password_hash,
    password_reset_token_hash,
    password_verify,
    public_user,
)
from simulator import simulator
from utils import utc_now


live_hub = LiveHub(lambda: q.get_live_tags(rows=0), interval=0.25)
logger = logging.getLogger(__name__)

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


class PlanEditorModel(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class SignInRequest(BaseModel):
    email: str
    password: str


class GoogleSignInRequest(BaseModel):
    credential: str


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=20, max_length=500)
    new_password: str = Field(min_length=8, max_length=128)


class UserInviteRequest(BaseModel):
    employee_id: str = Field(min_length=1, max_length=50)
    email: str = Field(min_length=3, max_length=320)
    role: Literal["admin", "sale_lead", "sale"] = "sale"
    position: str = Field(default="", max_length=200)
    first_th: str = Field(default="", max_length=100)
    last_th: str = Field(default="", max_length=100)
    first_en: str = Field(default="", max_length=100)
    last_en: str = Field(default="", max_length=100)
    phone: str = Field(default="", max_length=50)


class ProjectCreate(BaseModel):
    project_id: str
    name: str
    province: str = ""
    plan_id: str = ""
    plan_name: str = ""
    width_m: float = 20.0
    height_m: float = 20.0


class AnchorCreate(BaseModel):
    anchor_id: str
    plan_id: str | None = None
    hardware_address: str | None = None
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
    hardware_address: str | None = Field(default=None, max_length=32)
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


class RangeMeasurement(BaseModel):
    anchor_id: str
    distance_m: float


class PositioningIngest(BaseModel):
    tag_id: str
    ranges: list[RangeMeasurement]


class HardwareGatewayCreate(BaseModel):
    device_id: NonEmptyText
    plan_id: NonEmptyText
    description: str = ""
    enabled: bool = True


class TagRegistration(BaseModel):
    tag_id: NonEmptyText
    plan_id: NonEmptyText
    employee_id: str | None = None


# ---------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------

def current_user(x_session: str | None) -> dict[str, Any] | None:
    if not x_session:
        return None
    user_id = q.get_session_user(x_session)
    if not user_id:
        return None
    user = q.get_user_by_id(user_id)
    if not user or user.get("account_status", "active") != "active":
        q.delete_session(x_session)
        return None
    return user


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


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _normal_hardware_address(value: Any) -> str:
    return re.sub(r"[^0-9a-f]", "", str(value or ""), flags=re.IGNORECASE).upper()


def _point_in_polygon(x: float, y: float, points: list[Any]) -> bool:
    inside = False
    previous = points[-1]
    for current in points:
        if not isinstance(current, (list, tuple)) or not isinstance(previous, (list, tuple)):
            previous = current
            continue
        xi = _finite_number(current[0] if len(current) > 0 else None)
        yi = _finite_number(current[1] if len(current) > 1 else None)
        xj = _finite_number(previous[0] if len(previous) > 0 else None)
        yj = _finite_number(previous[1] if len(previous) > 1 else None)
        if None not in (xi, yi, xj, yj):
            intersects = (yi > y) != (yj > y) and x < ((xj - xi) * (y - yi) / (yj - yi) + xi)
            if intersects:
                inside = not inside
        previous = current
    return inside


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
    if settings.auto_migrate:
        init_db()
    if settings.seed_demo_data:
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
    try:
        db.readiness()
    except DatabaseError:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "service": "supalai-tracking-api",
                "database": "postgres",
                "error": "PostgreSQL is reachable but the application schema is not accessible",
                "time": utc_now().isoformat(),
            },
        )
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
    return {
        "enabled": enabled,
        "client_id": settings.google_client_id if enabled else None,
        "hosted_domain": settings.google_workspace_domain or None,
    }


@app.post("/api/signin")
def signin(payload: SignInRequest):
    user = q.get_user_by_email(payload.email.strip().lower())
    if (
        not user
        or user.get("account_status", "active") != "active"
        or not password_verify(payload.password, user.get("password_hash"))
    ):
        return {"ok": False, "error": "Email หรือ Password ไม่ถูกต้อง หรือบัญชียังไม่เปิดใช้งาน"}
    token = create_token(user["id"])
    return {"ok": True, "token": token, "user": public_user(user)}


@app.post("/api/signout")
def signout(x_session: str | None = Header(default=None)):
    if x_session:
        q.delete_session(x_session)
    return {"ok": True}


@app.post("/api/auth/forgot-password")
def forgot_password(payload: ForgotPasswordRequest, background_tasks: BackgroundTasks):
    """Create and email a one-time reset link without revealing account existence."""
    response = {
        "ok": True,
        "message": "หากอีเมลนี้อยู่ในระบบ เราได้ส่งลิงก์สำหรับตั้งรหัสผ่านใหม่แล้ว",
    }
    user = q.get_user_by_email(payload.email.strip().lower())
    if (
        not user
        or user.get("account_status", "active") != "active"
        or q.has_recent_password_reset(user["id"], settings.password_reset_cooldown_seconds)
    ):
        return response

    token, token_hash = create_password_reset_token()
    expires_at = utc_now() + timedelta(minutes=settings.password_reset_minutes)
    q.create_password_reset(user["id"], token_hash, expires_at)
    # Keep the token in the URL fragment so browsers do not send it to the
    # web server in request logs or Referer headers.
    reset_url = f"{settings.frontend_base_url.rstrip('/')}/reset-password.html#token={token}"
    background_tasks.add_task(send_password_reset_email, user["email"], reset_url)
    return response


@app.post("/api/auth/reset-password")
def reset_password(payload: ResetPasswordRequest):
    token_hash = password_reset_token_hash(payload.token)
    if not q.password_reset_is_valid(token_hash):
        raise HTTPException(status_code=400, detail="ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว")
    purpose = q.consume_password_reset(
        token_hash,
        password_hash(payload.new_password),
    )
    if not purpose:
        raise HTTPException(status_code=400, detail="ลิงก์ตั้งรหัสผ่านไม่ถูกต้อง หมดอายุ หรือถูกใช้ไปแล้ว")
    message = (
        "เปิดใช้งานบัญชีและตั้งรหัสผ่านเรียบร้อยแล้ว กรุณาเข้าสู่ระบบ"
        if purpose == "activation"
        else "ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบอีกครั้ง"
    )
    return {"ok": True, "purpose": purpose, "message": message}


@app.post("/api/google-signin")
def google_signin(payload: GoogleSignInRequest):
    if not settings.google_client_id:
        return {"ok": False, "error": "Google Sign-In ยังไม่ได้ตั้งค่าใน .env"}
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests

        info = id_token.verify_oauth2_token(payload.credential, google_requests.Request(), settings.google_client_id)
        email = str(info.get("email", "")).lower().strip()
        google_sub = str(info.get("sub", "")).strip()
        if not email or not google_sub or not info.get("email_verified"):
            return {"ok": False, "error": "บัญชี Google ไม่มีอีเมลที่ยืนยันแล้ว"}
        if settings.google_workspace_domain and info.get("hd") != settings.google_workspace_domain:
            return {"ok": False, "error": f"กรุณาใช้บัญชี Google Workspace @{settings.google_workspace_domain}"}

        user = q.get_user_by_google_sub(google_sub)
        if not user:
            user = q.get_user_by_email(email)
            if user:
                try:
                    user = q.link_google_account(user["id"], google_sub)
                except UniqueViolation:
                    user = q.get_user_by_google_sub(google_sub)
        if not user:
            return {"ok": False, "error": "ยังไม่มีบัญชีนี้ในระบบ กรุณาติดต่อ Admin เพื่อส่งคำเชิญ"}
        if user.get("account_status", "active") == "pending":
            return {"ok": False, "error": "บัญชียังไม่เปิดใช้งาน กรุณาเปิดลิงก์คำเชิญในอีเมลก่อน"}
        if user.get("account_status", "active") != "active":
            return {"ok": False, "error": "บัญชีนี้ถูกระงับการใช้งาน"}

        token = create_token(user["id"])
        return {"ok": True, "token": token, "user": public_user(user)}
    except ImportError:
        return {"ok": False, "error": "ยังไม่ได้ติดตั้ง google-auth"}
    except Exception:
        logger.exception("Google Sign-In failed")
        return {"ok": False, "error": "Google Sign-In ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"}


def _account_link(token: str) -> str:
    return f"{settings.frontend_base_url.rstrip('/')}/reset-password.html#token={token}"


def _admin_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "employee_id": user["employee_id"],
        "email": user["email"],
        "role": user["role"],
        "position": user["position"],
        "first_th": user["first_th"],
        "last_th": user["last_th"],
        "first_en": user["first_en"],
        "last_en": user["last_en"],
        "phone": user.get("phone", ""),
        "tag_id": user.get("tag_id"),
        "account_status": user.get("account_status", "active"),
        "google_linked": bool(user.get("google_sub")),
        "activated_at": user.get("activated_at"),
        "created_at": user.get("created_at"),
    }


@app.get("/api/admin/users")
def admin_users(x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    return {"ok": True, "users": [_admin_user(user) for user in q.all_users()]}


@app.post("/api/admin/users/invite", status_code=201)
def admin_invite_user(
    payload: UserInviteRequest,
    background_tasks: BackgroundTasks,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    data = payload.model_dump()
    data["employee_id"] = data["employee_id"].strip()
    data["email"] = data["email"].strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", data["email"]):
        raise HTTPException(status_code=422, detail="รูปแบบอีเมลไม่ถูกต้อง")

    token, token_hash = create_password_reset_token()
    expires_at = utc_now() + timedelta(hours=settings.activation_hours)
    try:
        user = q.create_invited_user(
            f"u-{secrets.token_hex(8)}",
            data,
            token_hash,
            expires_at,
        )
    except UniqueViolation:
        raise HTTPException(status_code=409, detail="อีเมลหรือรหัสพนักงานนี้มีอยู่ในระบบแล้ว")
    if not user:
        raise HTTPException(status_code=500, detail="สร้างบัญชีไม่สำเร็จ")

    background_tasks.add_task(send_activation_email, user["email"], _account_link(token))
    return {"ok": True, "message": "สร้างบัญชีและส่งคำเชิญแล้ว", "user": _admin_user(user)}


@app.post("/api/admin/users/{user_id}/resend-invitation")
def admin_resend_invitation(
    user_id: str,
    background_tasks: BackgroundTasks,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    user = q.get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="ไม่พบบัญชีผู้ใช้")
    if user.get("account_status") != "pending":
        raise HTTPException(status_code=409, detail="ส่งคำเชิญซ้ำได้เฉพาะบัญชีที่ยัง pending")
    if q.has_recent_password_reset(user_id, settings.password_reset_cooldown_seconds, "activation"):
        return {"ok": True, "message": "คำเชิญถูกส่งไปเมื่อไม่นานนี้ กรุณารอสักครู่"}

    token, token_hash = create_password_reset_token()
    expires_at = utc_now() + timedelta(hours=settings.activation_hours)
    q.create_password_reset(user_id, token_hash, expires_at, "activation")
    background_tasks.add_task(send_activation_email, user["email"], _account_link(token))
    return {"ok": True, "message": "ส่งคำเชิญอีกครั้งแล้ว"}


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
        if p.get("account_status", "active") == "active"
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
def devices(
    x_session: str | None = Header(default=None),
    project: str | None = None,
    plan: str | None = None,
):
    require_user(x_session)
    return {
        "ok": True,
        "anchors": q.get_anchors(project_id=project, plan_id=plan),
        "tags": q.get_tags(project_id=project, plan_id=plan),
    }


@app.get("/api/live")
def live(
    x_session: str | None = Header(default=None),
    since: float = 0,
    rows: int = 400,
    project: str | None = None,
    plan: str | None = None,
):
    require_user(x_session)
    return q.get_live_tags(rows=rows, since=since, project_id=project, plan_id=plan)


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
    project = q.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    return project


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
    data = payload.model_dump()
    data["hardware_address"] = _normal_hardware_address(data.get("hardware_address")) or None
    try:
        anchor = q.create_plan_anchor(plan_id, data)
    except UniqueViolation as exc:
        raise HTTPException(status_code=409, detail="Anchor ID or hardware address is already in use") from exc
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


@app.get("/api/projects/{project_id}/hardware-gateways")
def hardware_gateways(project_id: str, x_session: str | None = Header(default=None)):
    require_role(x_session, {"admin"})
    rows = db.fetchall(
        """
        SELECT device_id, project_id, plan_id, description, enabled,
               last_seen, last_message_id, created_at, updated_at
        FROM hardware_gateways
        WHERE project_id = %s
        ORDER BY device_id
        """,
        (project_id,),
    )
    now = utc_now()
    for row in rows:
        row["on"] = bool(row["last_seen"] and (now - row["last_seen"]).total_seconds() <= 10)
    return {"ok": True, "gateways": rows}


@app.post("/api/projects/{project_id}/hardware-gateways")
def hardware_gateway_create(
    project_id: str,
    payload: HardwareGatewayCreate,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    plan = require_plan(payload.plan_id)
    if plan["project_id"] != project_id:
        raise HTTPException(status_code=422, detail="Plan does not belong to this project")
    gateway = db.execute_returning(
        """
        INSERT INTO hardware_gateways (device_id, project_id, plan_id, description, enabled)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (device_id) DO UPDATE SET
            project_id = EXCLUDED.project_id,
            plan_id = EXCLUDED.plan_id,
            description = EXCLUDED.description,
            enabled = EXCLUDED.enabled,
            updated_at = now()
        RETURNING device_id, project_id, plan_id, description, enabled,
                  last_seen, last_message_id, created_at, updated_at
        """,
        (payload.device_id, project_id, payload.plan_id, payload.description, payload.enabled),
    )
    return {"ok": True, "gateway": gateway}


@app.post("/api/projects/{project_id}/tags")
def project_tag_create(
    project_id: str,
    payload: TagRegistration,
    x_session: str | None = Header(default=None),
):
    require_role(x_session, {"admin"})
    plan = require_plan(payload.plan_id)
    if plan["project_id"] != project_id:
        raise HTTPException(status_code=422, detail="Plan does not belong to this project")
    tag = db.execute_returning(
        """
        INSERT INTO tags (tag_id, employee_id, project_id, plan_id)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (tag_id) DO UPDATE SET
            employee_id = COALESCE(EXCLUDED.employee_id, tags.employee_id),
            project_id = EXCLUDED.project_id,
            plan_id = EXCLUDED.plan_id
        RETURNING tag_id, employee_id, project_id, plan_id, x, y, z,
                  battery, last_ts, source, device_id
        """,
        (payload.tag_id, payload.employee_id, project_id, payload.plan_id),
    )
    return {"ok": True, "tag": tag}


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

@app.post("/api/hardware/ingest")
async def hardware_ingest(request: Request):
    """Authenticate an on-site UWB gateway and persist one idempotent fix."""
    secret = settings.hardware_ingest_secret
    if len(secret) < 32:
        raise HTTPException(status_code=503, detail="Hardware ingestion is not configured")

    raw_body = await request.body()
    device_id = request.headers.get("x-uwb-device-id", "").strip()
    timestamp_text = request.headers.get("x-uwb-timestamp", "")
    signature = request.headers.get("x-uwb-signature", "")
    if not device_id or not re.fullmatch(r"\d{10}", timestamp_text) or not re.fullmatch(r"[0-9a-fA-F]{64}", signature):
        raise HTTPException(status_code=401, detail="Invalid or expired hardware signature")
    timestamp = int(timestamp_text)
    if abs(time.time() - timestamp) > 120:
        raise HTTPException(status_code=401, detail="Invalid or expired hardware signature")
    signed = device_id.encode() + b"." + timestamp_text.encode() + b"." + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature.lower()):
        raise HTTPException(status_code=401, detail="Invalid or expired hardware signature")

    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Body must be valid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")

    message_id = str(payload.get("message_id") or "").strip()
    tag_id = str(payload.get("tag_id") or "").strip()
    if not message_id or len(message_id) > 160 or not tag_id or len(tag_id) > 100:
        raise HTTPException(status_code=400, detail="message_id and tag_id are required")

    gateway = db.fetchone(
        """
        SELECT gateway.device_id, gateway.project_id, gateway.plan_id, gateway.enabled,
               plan.width_m, plan.height_m
        FROM hardware_gateways AS gateway
        JOIN plans AS plan ON plan.id = gateway.plan_id
        WHERE gateway.device_id = %s
        """,
        (device_id,),
    )
    if not gateway or not gateway["enabled"]:
        raise HTTPException(status_code=403, detail="Gateway is not registered or is disabled")

    registered_tag = db.fetchone(
        "SELECT tag_id, project_id, tag_type FROM tags WHERE tag_id = %s",
        (tag_id,),
    )
    if not registered_tag:
        raise HTTPException(status_code=404, detail="Tag is not registered")
    if registered_tag["project_id"] and registered_tag["project_id"] != gateway["project_id"]:
        raise HTTPException(status_code=422, detail="Tag belongs to a different project")
    if registered_tag["tag_type"] == "mock":
        raise HTTPException(status_code=422, detail="Mock tags cannot report through hardware ingest")

    measured_at = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    if payload.get("measured_at"):
        try:
            measured_at = datetime.fromisoformat(str(payload["measured_at"]).replace("Z", "+00:00"))
            if measured_at.tzinfo is None:
                measured_at = measured_at.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="measured_at is invalid") from exc
    if abs((utc_now() - measured_at).total_seconds()) > 300:
        raise HTTPException(status_code=400, detail="measured_at is invalid or too old")

    fix_x: float | None = None
    fix_y: float | None = None
    fix_z: float | None = None
    residual_m: float | None = None
    anchors_used: int | None = None
    source = "hardware_position"
    anchor_status: list[dict[str, Any]] = []

    position = payload.get("position")
    if isinstance(position, dict):
        fix_x = _finite_number(position.get("x"))
        fix_y = _finite_number(position.get("y"))
        fix_z = _finite_number(position.get("z"))
        residual_m = _finite_number(position.get("residual_m"))
        used = _finite_number(position.get("anchors_used"))
        anchors_used = int(used) if used is not None else None
        if fix_x is None or fix_y is None:
            raise HTTPException(status_code=400, detail="position.x and position.y must be numbers in metres")
    else:
        anchors = q.get_anchors(gateway["project_id"], gateway["plan_id"])
        anchor_map: dict[str, dict[str, Any]] = {}
        for anchor in anchors:
            anchor_map[_normal_hardware_address(anchor["anchor_id"])] = anchor
            if anchor.get("hardware_address"):
                anchor_map[_normal_hardware_address(anchor["hardware_address"])] = anchor
        known: dict[str, tuple[dict[str, Any], float]] = {}
        ranges = payload.get("ranges") if isinstance(payload.get("ranges"), list) else []
        for item in ranges:
            if not isinstance(item, dict):
                continue
            anchor = anchor_map.get(_normal_hardware_address(item.get("anchor_id")))
            distance = _finite_number(item.get("distance_m"))
            if anchor and distance is not None and 0 < distance <= 1000:
                known[anchor["anchor_id"]] = (anchor, distance)
        if len(known) < 3:
            raise HTTPException(status_code=400, detail=f"At least 3 mapped anchors are required; received {len(known)}")
        ordered = list(known.values())
        calculated = positioning.trilaterate(
            [(item[0]["x"], item[0]["y"]) for item in ordered],
            [item[1] for item in ordered],
        )
        if calculated is None:
            raise HTTPException(status_code=422, detail="Anchor geometry cannot produce a position")
        fix_x, fix_y = calculated.x, calculated.y
        residual_m, anchors_used = calculated.residual_m, calculated.anchors_used
        source = "uwb_ranges"
        reported_status = payload.get("anchor_status") if isinstance(payload.get("anchor_status"), list) else []
        battery_by_address = {
            _normal_hardware_address(item.get("anchor_id")): _finite_number(item.get("battery"))
            for item in reported_status if isinstance(item, dict)
        }
        anchor_status = [
            {
                "anchor_id": anchor["anchor_id"],
                "battery": battery_by_address.get(_normal_hardware_address(anchor.get("hardware_address") or anchor["anchor_id"])),
            }
            for anchor, _distance in ordered
        ]

    assert fix_x is not None and fix_y is not None
    if fix_x < -2 or fix_x > gateway["width_m"] + 2 or fix_y < -2 or fix_y > gateway["height_m"] + 2:
        raise HTTPException(status_code=422, detail="Calculated position is outside the plan boundary")
    if residual_m is not None and residual_m > 3:
        raise HTTPException(status_code=422, detail=f"Position rejected: residual {residual_m:.3f} m is too high")

    zones = db.fetchall(
        """
        SELECT name, geometry, x_min, x_max, y_min, y_max
        FROM zones WHERE project_id = %s AND plan_id = %s ORDER BY id
        """,
        (gateway["project_id"], gateway["plan_id"]),
    )
    zone = None
    for candidate in zones:
        points = (candidate.get("geometry") or {}).get("points")
        inside = _point_in_polygon(fix_x, fix_y, points) if isinstance(points, list) and len(points) >= 3 else (
            candidate["x_min"] <= fix_x <= candidate["x_max"]
            and candidate["y_min"] <= fix_y <= candidate["y_max"]
        )
        if inside:
            zone = candidate["name"]
            break

    row = db.fetchone(
        """
        SELECT ingest_hardware_fix(
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb
        ) AS result
        """,
        (
            device_id, message_id, tag_id, measured_at, fix_x, fix_y, fix_z,
            zone, source, residual_m, anchors_used, _finite_number(payload.get("tag_battery")),
            Json(anchor_status),
        ),
    )
    return row["result"] if row else {"ok": False}


@app.get("/api/positioning/{project_id}")
def positioning_snapshot(project_id: str, x_session: str | None = Header(default=None)):
    require_user(x_session)
    if not q.get_project(project_id):
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")
    live = q.get_live_tags(rows=0)
    return {"ok": True, "project_id": project_id, "tags": live.get("tags", {})}


@app.post("/api/positioning/{project_id}/ingest")
def positioning_ingest(project_id: str, payload: PositioningIngest, x_session: str | None = Header(default=None)):
    """Real UWB positioning entry point: turn raw anchor-to-tag ranges into
    an (x, y) fix via least-squares multilateration (see positioning.py),
    persist it, and keep the visit lifecycle in sync — exactly like the
    demo simulator does, so real hardware can replace the simulator with
    no other backend changes. Point your anchor gateway / tag firmware
    here once it's reporting real two-way-ranging distances."""
    require_user(x_session)

    project = q.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="ไม่พบโครงการ")

    anchor_by_id = {a["anchor_id"]: (a["x"], a["y"]) for a in project["anchors"]}
    known = [(anchor_by_id[r.anchor_id], r.distance_m) for r in payload.ranges if r.anchor_id in anchor_by_id]

    if len(known) < 3:
        raise HTTPException(
            status_code=400,
            detail=f"ต้องมีระยะจาก anchor ที่รู้จักในโครงการนี้อย่างน้อย 3 จุด (ได้รับ {len(known)})",
        )

    anchor_positions = [k[0] for k in known]
    distances = [k[1] for k in known]
    fix = positioning.trilaterate(anchor_positions, distances)
    if fix is None:
        raise HTTPException(status_code=422, detail="คำนวณตำแหน่งไม่สำเร็จ (ระยะที่ได้อาจไม่สอดคล้องกัน)")

    result = tracking.ingest_fix(payload.tag_id, fix.x, fix.y)
    return {
        "ok": True,
        "tag_id": payload.tag_id,
        "x": round(fix.x, 3),
        "y": round(fix.y, 3),
        "zone": result["zone"],
        "residual_m": fix.residual_m,
        "anchors_used": fix.anchors_used,
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


@app.get("/reset-password.html", include_in_schema=False)
def frontend_reset_password():
    file = FRONTEND_DIR / "reset-password.html"
    if file.exists():
        return FileResponse(file)
    raise HTTPException(status_code=404)


@app.get("/plan-editor.html", include_in_schema=False)
def frontend_plan_editor():
    file = FRONTEND_DIR / "plan-editor.html"
    if file.exists():
        return FileResponse(file)
    raise HTTPException(status_code=404)


@app.get("/logo.jpg", include_in_schema=False)
def frontend_logo():
    file = FRONTEND_DIR / "logo.jpg"
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
