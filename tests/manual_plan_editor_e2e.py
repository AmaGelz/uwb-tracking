"""Disposable Plan Editor smoke test against a running local API and test DB.

The script creates an admin session and an isolated project, exercises the
freeform API contracts, then drives the real editor in headless Microsoft Edge
through the Chrome DevTools Protocol.  The session and project are deleted in
``finally`` so the test database is left clean.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import traceback
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid

from dotenv import dotenv_values
import psycopg2
import websocket


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BROWSER = next(
    (
        path for path in (
            Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        )
        if path.exists()
    ),
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)
    print(f"PASS  {message}", flush=True)


class ApiClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        expected: int = 200,
    ) -> dict[str, Any]:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"X-Session": self.token}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + path, data=payload, headers=headers, method=method)
        try:
            with urlopen(request, timeout=20) as response:
                status = response.status
                result = json.loads(response.read() or b"{}")
        except HTTPError as exc:
            status = exc.code
            raw = exc.read()
            try:
                result = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                result = {"detail": raw.decode("utf-8", errors="replace") or exc.reason}
        if status != expected:
            raise AssertionError(f"{method} {path}: expected HTTP {expected}, got {status}: {result}")
        return result

    def hardware_ingest(self, device_id: str, secret: str, body: dict[str, Any]) -> dict[str, Any]:
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        timestamp = str(int(time.time()))
        signed = device_id.encode() + b"." + timestamp.encode() + b"." + raw
        signature = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
        request = Request(
            self.base_url + "/api/hardware/ingest",
            data=raw,
            headers={
                "Content-Type": "application/json",
                "X-UWB-Device-ID": device_id,
                "X-UWB-Timestamp": timestamp,
                "X-UWB-Signature": signature,
            },
            method="POST",
        )
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read() or b"{}")


class Cdp:
    def __init__(self, websocket_url: str):
        self.socket = websocket.create_connection(websocket_url, timeout=15, origin="http://localhost")
        self.sequence = 0

    def close(self) -> None:
        self.socket.close()

    def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.sequence += 1
        sequence = self.sequence
        self.socket.send(json.dumps({"id": sequence, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.socket.recv())
            if message.get("id") != sequence:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP {method}: {message['error']}")
            return message.get("result", {})

    def evaluate(self, expression: str, await_promise: bool = False) -> Any:
        response = self.command(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": True,
                "awaitPromise": await_promise,
                "userGesture": True,
            },
        )
        if response.get("exceptionDetails"):
            details = response["exceptionDetails"]
            raise RuntimeError(details.get("exception", {}).get("description") or details.get("text"))
        result = response.get("result", {})
        if result.get("subtype") == "error":
            raise RuntimeError(result.get("description", "browser evaluation failed"))
        return result.get("value")


def wait_until(predicate, message: str, timeout: float = 15.0) -> Any:
    deadline = time.monotonic() + timeout
    last_value = None
    while time.monotonic() < deadline:
        last_value = predicate()
        if last_value:
            return last_value
        time.sleep(0.15)
    raise AssertionError(f"timed out: {message}; last value={last_value!r}")


def migration_checks(connection) -> None:
    expected = {
        "plans.boundary", "plans.ceiling_height_m",
        "zones.zone_type", "zones.color", "zones.opacity", "zones.is_visible", "zones.stack_order",
        "anchors.mount_type", "anchors.orientation_deg", "anchors.wall_ref",
        "anchors.gateway_device_id", "anchors.bound_tag_id",
    }
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN ('plans', 'zones', 'anchors')
            """
        )
        actual = {f"{table}.{column}" for table, column in cursor.fetchall()}
        check(expected <= actual, "migration 005 columns exist")
        cursor.execute(
            """
            SELECT count(*) FILTER (WHERE boundary IS NULL),
                   count(*) FILTER (WHERE jsonb_array_length(boundary -> 'points') < 3)
            FROM plans
            """
        )
        check(cursor.fetchone() == (0, 0), "all legacy plans have valid polygon boundaries")
        cursor.execute(
            """
            SELECT count(*) FILTER (WHERE mount_type IS NULL),
                   count(*) FILTER (WHERE orientation_deg IS NULL)
            FROM anchors
            """
        )
        check(cursor.fetchone() == (0, 0), "legacy anchors received mount/orientation defaults")
        cursor.execute(
            """
            SELECT count(*) FILTER (
                WHERE zone_type IS NULL OR color IS NULL OR opacity IS NULL
            )
            FROM zones
            """
        )
        check(cursor.fetchone()[0] == 0, "legacy zones received display metadata defaults")


def cleanup_stale_runs(connection) -> None:
    """Remove only artifacts carrying this harness's explicit test markers."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE FROM tags
            WHERE project_id IN (
                SELECT id FROM projects WHERE id LIKE 'E2E-%' AND province = 'TEST ONLY'
            )
            """
        )
        cursor.execute("DELETE FROM projects WHERE id LIKE 'E2E-%' AND province = 'TEST ONLY'")
        removed_projects = cursor.rowcount
        cursor.execute("DELETE FROM sessions WHERE token LIKE 'e2e-%'")
        removed_sessions = cursor.rowcount
    connection.commit()
    if removed_projects or removed_sessions:
        print(f"CLEAN  removed stale harness artifacts: {removed_projects} project(s), {removed_sessions} session(s)", flush=True)


def create_test_session(connection, token: str) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id FROM users
            WHERE role = 'admin' AND account_status = 'active'
            ORDER BY id LIMIT 1
            """
        )
        row = cursor.fetchone()
        if not row:
            raise AssertionError("test database has no active admin user")
        cursor.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (%s, %s, now() + interval '2 hours')",
            (token, row[0]),
        )
    connection.commit()
    return row[0]


def api_tests(
    client: ApiClient,
    project_id: str,
    plan_id: str,
    suffix: str,
    hardware_secret: str,
) -> dict[str, Any]:
    client.call("POST", "/api/projects", {
        "project_id": project_id,
        "name": f"Plan Editor E2E {suffix}",
        "province": "TEST ONLY",
    })
    l_shape = [
        {"x": 0, "y": 0}, {"x": 20, "y": 0}, {"x": 20, "y": 14},
        {"x": 12, "y": 14}, {"x": 12, "y": 20}, {"x": 0, "y": 20},
    ]
    created = client.call("POST", f"/api/projects/{project_id}/plans", {
        "plan_id": plan_id,
        "name": f"L Shape E2E {suffix}",
        "boundary": {"type": "polygon", "points": l_shape},
        "ceiling_height_m": 3.2,
        "is_active": True,
    })["plan"]
    check(len(created["boundary"]["points"]) == 6, "API creates a six-vertex L-shaped plan")
    check(math.isclose(created["area_m2"], 352.0), "API calculates L-shaped plan area")
    check(created["width_m"] == 20 and created["height_m"] == 20, "API returns polygon bounding-box dimensions")

    edited_shape = [*l_shape]
    edited_shape[4] = {"x": 12, "y": 22}
    edited_shape[5] = {"x": 0, "y": 22}
    updated = client.call("PUT", f"/api/plans/{plan_id}", {
        "boundary": {"type": "polygon", "points": edited_shape},
        "version": 2,
    })["plan"]
    check(math.isclose(updated["area_m2"], 376.0), "API persists vertex edits and recalculates area")
    project_after_resize = client.call("GET", f"/api/projects/{project_id}")
    check(updated["width_m"] == 20 and updated["height_m"] == 22
          and project_after_resize["width_m"] == 20 and project_after_resize["height_m"] == 22,
          "boundary edits synchronize plan and legacy project width/height fields")
    reloaded = client.call("GET", f"/api/plans/{plan_id}")["plan"]
    reloaded_points = [
        [float(point[0]), float(point[1])] if isinstance(point, list)
        else [float(point["x"]), float(point["y"])]
        for point in reloaded["boundary"]["points"]
    ]
    expected_points = [[float(point["x"]), float(point["y"])] for point in edited_shape]
    check(reloaded_points == expected_points, "L-shaped boundary reloads without distortion")

    legacy_id = f"LEGACY-{suffix}"
    legacy = client.call("POST", f"/api/projects/{project_id}/plans", {
        "plan_id": legacy_id,
        "name": f"Legacy rectangle {suffix}",
        "width_m": 9,
        "height_m": 7,
        "is_active": False,
    })["plan"]
    check(len(legacy["boundary"]["points"]) == 4 and math.isclose(legacy["area_m2"], 63),
          "legacy width/height API input converts to a rectangle polygon")

    invalid = client.call("POST", f"/api/projects/{project_id}/plans", {
        "plan_id": f"BAD-{suffix}", "name": "Invalid boundary",
        "boundary": {"type": "polygon", "points": [{"x": 0, "y": 0}, {"x": 1, "y": 1}]},
    }, expected=422)
    check(bool(invalid.get("detail")), "API rejects an unclosed-capable boundary with fewer than three vertices")

    zones = []
    for payload in (
        {
            "name": f"Waiting {suffix}", "zone_type": "waiting_area", "color": "#4F9DDE", "opacity": 0.35,
            "geometry": {"type": "polygon", "points": [
                {"x": 1, "y": 1}, {"x": 9, "y": 1}, {"x": 9, "y": 7}, {"x": 1, "y": 7},
            ]},
        },
        {
            "name": f"Restricted {suffix}", "zone_type": "restricted_area", "color": "#D92D20", "opacity": 0.5,
            "geometry": {"type": "polygon", "points": [
                {"x": 5, "y": 4}, {"x": 13, "y": 4}, {"x": 13, "y": 10}, {"x": 5, "y": 10},
            ]},
        },
    ):
        zones.append(client.call("POST", f"/api/plans/{plan_id}/zones", payload)["zone"])
    zone_rows = client.call("GET", f"/api/plans/{plan_id}/zones")["zones"]
    check(len(zone_rows) == 2 and all(math.isclose(zone["area_m2"], 48) for zone in zone_rows),
          "overlapping polygon zones persist with calculated areas")
    changed_zone = client.call("PUT", f"/api/plans/{plan_id}/zones/{zones[0]['zone_id']}", {
        "zone_type": "storage", "color": "#12B76A", "opacity": 0.4, "stack_order": 9,
    })["zone"]
    check(changed_zone["zone_type"] == "storage" and changed_zone["stack_order"] == 9,
          "zone metadata and stacking order update")

    gateway_id = f"GW-{suffix}"
    tag_id = f"TAG-{suffix}"
    client.call("POST", f"/api/projects/{project_id}/hardware-gateways", {
        "device_id": gateway_id, "plan_id": plan_id, "description": "E2E", "enabled": True,
    })
    client.call("POST", f"/api/projects/{project_id}/tags", {"tag_id": tag_id, "plan_id": plan_id})
    anchors = (
        {
            "anchor_id": f"WALL-{suffix}", "hardware_address": "1782", "x": 5, "y": 0, "z": 2.5,
            "mount_type": "wall", "orientation_deg": 450,
            "wall_ref": {"edgeIndex": 0, "offsetRatio": 0.25, "facingSide": "inside"},
            "gateway_device_id": gateway_id, "bound_tag_id": tag_id,
        },
        {"anchor_id": f"CEIL-{suffix}", "hardware_address": "1783", "x": 6, "y": 5, "z": None, "mount_type": "ceiling", "orientation_deg": 30},
        {"anchor_id": f"FREE-{suffix}", "hardware_address": "1784", "x": 10, "y": 8},
    )
    for anchor in anchors:
        client.call("POST", f"/api/plans/{plan_id}/anchors", anchor)
    anchor_rows = client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
    by_id = {anchor["anchor_id"]: anchor for anchor in anchor_rows}
    check(by_id[f"WALL-{suffix}"]["orientation_deg"] == 90
          and by_id[f"WALL-{suffix}"]["wall_ref"]["edgeIndex"] == 0,
          "wall anchor mount, normalized orientation, wall reference and bindings persist")
    check(math.isclose(by_id[f"CEIL-{suffix}"]["z"], 3.2), "ceiling anchor defaults Z to plan ceiling height")
    check(by_id[f"FREE-{suffix}"]["mount_type"] == "free"
          and by_id[f"FREE-{suffix}"]["z"] == 0
          and by_id[f"FREE-{suffix}"]["orientation_deg"] == 0,
          "legacy-style anchor payload receives free/Z/orientation defaults")

    metadata_before_ingest = {
        anchor_id: (row["mount_type"], row["orientation_deg"], row["wall_ref"])
        for anchor_id, row in by_id.items()
    }
    ingest_result = client.hardware_ingest(gateway_id, hardware_secret, {
        "message_id": f"MSG-{suffix}",
        "tag_id": tag_id,
        "ranges": [
            {"anchor_id": "1782", "distance_m": math.sqrt(29)},
            {"anchor_id": "1783", "distance_m": 1},
            {"anchor_id": "1784", "distance_m": math.sqrt(18)},
        ],
        "anchor_status": [
            {"anchor_id": "1782", "battery": 91},
            {"anchor_id": "1783", "battery": 92},
            {"anchor_id": "1784", "battery": 93},
        ],
    })
    check(ingest_result.get("ok") is True, "signed hardware position ingest succeeds")
    after_ingest = {
        row["anchor_id"]: row
        for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
    }
    check(all(
        metadata_before_ingest[anchor_id]
        == (row["mount_type"], row["orientation_deg"], row["wall_ref"])
        for anchor_id, row in after_ingest.items()
    ), "hardware ingestion preserves mount type, orientation and wall reference metadata")

    topology_change = [
        {"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 20, "y": 0},
        {"x": 20, "y": 14}, {"x": 12, "y": 14}, {"x": 12, "y": 24}, {"x": 0, "y": 24},
    ]
    topology_plan = client.call("PUT", f"/api/plans/{plan_id}", {
        "boundary": {"type": "polygon", "points": topology_change},
    })["plan"]
    topology_project = client.call("GET", f"/api/projects/{project_id}")
    reviewed_wall = next(
        row for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
        if row["anchor_id"] == f"WALL-{suffix}"
    )
    check(topology_plan["width_m"] == 20 and topology_plan["height_m"] == 24
          and topology_project["width_m"] == 20 and topology_project["height_m"] == 24,
          "topology-changing boundary edit keeps both width/height read paths synchronized")
    check(reviewed_wall["wall_ref"].get("needsReview") is True
          and reviewed_wall["wall_ref"].get("reviewReason") == "plan_boundary_changed",
          "boundary topology changes flag persisted boundary wall references for review")
    client.call("PUT", f"/api/plans/{plan_id}", {
        "boundary": {"type": "polygon", "points": edited_shape},
    })

    line = client.call("POST", f"/api/plans/{plan_id}/objects", {
        "object_type": "line", "label": "E2E line",
        "geometry": {"type": "line", "points": [{"x": 0, "y": 0}, {"x": 3, "y": 4}]},
        "properties": {"length_m": 5},
    })["object"]
    dimension = client.call("POST", f"/api/plans/{plan_id}/dimensions", {
        "x1": 0, "y1": 0, "x2": 3, "y2": 4,
    })["dimension"]
    check(math.isclose(dimension["length_m"], 5), "dimension API auto-calculates exact length")
    client.call("DELETE", f"/api/plans/{plan_id}/objects/{line['object_id']}")
    client.call("DELETE", f"/api/plans/{plan_id}/dimensions/{dimension['dimension_id']}")
    check(not client.call("GET", f"/api/plans/{plan_id}/objects")["objects"], "object delete persists")

    project_anchors = client.call("GET", f"/api/projects/{project_id}/anchors")["anchors"]
    check(len(project_anchors) == 3, "project tracking contract still exposes all anchor coordinates")
    return {"zone_count": 2, "anchor_count": 3, "edited_shape": edited_shape}


def create_browser_fixture(
    client: ApiClient,
    project_id: str,
    plan_id: str,
    suffix: str,
) -> dict[str, Any]:
    """Create only the records needed by browser tests.

    Keeping this path small lets constrained runners execute API integrity and
    browser interaction as separate commands without weakening either suite.
    """
    client.call("POST", "/api/projects", {
        "project_id": project_id,
        "name": f"Plan Editor browser E2E {suffix}",
        "province": "TEST ONLY",
    })
    edited_shape = [
        {"x": 0, "y": 0}, {"x": 20, "y": 0}, {"x": 20, "y": 14},
        {"x": 12, "y": 14}, {"x": 12, "y": 22}, {"x": 0, "y": 22},
    ]
    client.call("POST", f"/api/projects/{project_id}/plans", {
        "plan_id": plan_id,
        "name": f"Browser L Shape {suffix}",
        "boundary": {"type": "polygon", "points": edited_shape},
        "ceiling_height_m": 3.2,
        "is_active": True,
    })
    for payload in (
        {
            "name": f"Waiting {suffix}", "zone_type": "waiting_area",
            "color": "#4F9DDE", "opacity": 0.35,
            "geometry": {"type": "polygon", "points": [
                {"x": 1, "y": 1}, {"x": 9, "y": 1},
                {"x": 9, "y": 7}, {"x": 1, "y": 7},
            ]},
        },
        {
            "name": f"Restricted {suffix}", "zone_type": "restricted_area",
            "color": "#D92D20", "opacity": 0.5,
            "geometry": {"type": "polygon", "points": [
                {"x": 5, "y": 4}, {"x": 13, "y": 4},
                {"x": 13, "y": 10}, {"x": 5, "y": 10},
            ]},
        },
    ):
        client.call("POST", f"/api/plans/{plan_id}/zones", payload)
    for anchor in (
        {
            "anchor_id": f"WALL-{suffix}", "x": 5, "y": 0, "z": 2.5,
            "mount_type": "wall", "orientation_deg": 90,
            "wall_ref": {"source": "boundary", "edgeIndex": 0, "offsetRatio": 0.25},
        },
        {"anchor_id": f"CEIL-{suffix}", "x": 6, "y": 5, "mount_type": "ceiling"},
        {"anchor_id": f"FREE-{suffix}", "x": 10, "y": 8},
    ):
        client.call("POST", f"/api/plans/{plan_id}/anchors", anchor)
    print("PASS  minimal browser fixture created", flush=True)
    return {"zone_count": 2, "anchor_count": 3, "edited_shape": edited_shape}


def api_integrity_tests(
    client: ApiClient,
    project_id: str,
    plan_id: str,
    suffix: str,
    hardware_secret: str,
) -> dict[str, Any]:
    """Focused release-gate checks for silent persisted-data corruption."""
    client.call("POST", "/api/projects", {
        "project_id": project_id,
        "name": f"Plan Editor integrity E2E {suffix}",
        "province": "TEST ONLY",
    })
    boundary = [
        {"x": 0, "y": 0}, {"x": 20, "y": 0}, {"x": 20, "y": 14},
        {"x": 12, "y": 14}, {"x": 12, "y": 22}, {"x": 0, "y": 22},
    ]
    client.call("POST", f"/api/projects/{project_id}/plans", {
        "plan_id": plan_id,
        "name": f"Integrity L Shape {suffix}",
        "boundary": {"type": "polygon", "points": boundary},
        "is_active": True,
    })
    gateway_id = f"GW-{suffix}"
    tag_id = f"TAG-{suffix}"
    client.call("POST", f"/api/projects/{project_id}/hardware-gateways", {
        "device_id": gateway_id, "plan_id": plan_id, "description": "E2E", "enabled": True,
    })
    client.call("POST", f"/api/projects/{project_id}/tags", {"tag_id": tag_id, "plan_id": plan_id})
    for anchor in (
        {
            "anchor_id": f"WALL-{suffix}", "hardware_address": "1782",
            "x": 5, "y": 0, "z": 2.5, "mount_type": "wall", "orientation_deg": 90,
            "wall_ref": {"source": "boundary", "edgeIndex": 0, "offsetRatio": 0.25},
            "gateway_device_id": gateway_id, "bound_tag_id": tag_id,
        },
        {"anchor_id": f"CEIL-{suffix}", "hardware_address": "1783", "x": 6, "y": 5, "z": 3, "mount_type": "ceiling", "orientation_deg": 30},
        {"anchor_id": f"FREE-{suffix}", "hardware_address": "1784", "x": 10, "y": 8, "z": 1, "mount_type": "free", "orientation_deg": 15},
    ):
        client.call("POST", f"/api/plans/{plan_id}/anchors", anchor)

    before = {
        row["anchor_id"]: (row["mount_type"], row["z"], row["orientation_deg"], row["wall_ref"])
        for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
    }
    result = client.hardware_ingest(gateway_id, hardware_secret, {
        "message_id": f"MSG-{suffix}", "tag_id": tag_id,
        "ranges": [
            {"anchor_id": "1782", "distance_m": math.sqrt(29)},
            {"anchor_id": "1783", "distance_m": 1},
            {"anchor_id": "1784", "distance_m": math.sqrt(18)},
        ],
        "anchor_status": [{"anchor_id": value, "battery": 90 + index} for index, value in enumerate(("1782", "1783", "1784"), 1)],
    })
    check(result.get("ok") is True, "signed hardware position ingest succeeds")
    after = {
        row["anchor_id"]: (row["mount_type"], row["z"], row["orientation_deg"], row["wall_ref"])
        for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
    }
    check(after == before, "hardware ingestion preserves mount type, Z, orientation and wall reference metadata")

    changed = [
        {"x": 0, "y": 0}, {"x": 2, "y": 0}, {"x": 20, "y": 0},
        {"x": 20, "y": 14}, {"x": 12, "y": 14}, {"x": 12, "y": 24}, {"x": 0, "y": 24},
    ]
    plan = client.call("PUT", f"/api/plans/{plan_id}", {
        "boundary": {"type": "polygon", "points": changed},
    })["plan"]
    project = client.call("GET", f"/api/projects/{project_id}")
    wall = next(
        row for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]
        if row["anchor_id"] == f"WALL-{suffix}"
    )
    check(plan["width_m"] == 20 and plan["height_m"] == 24
          and project["width_m"] == 20 and project["height_m"] == 24,
          "boundary edit synchronizes Plan and Project bounding-box read paths")
    check(wall["wall_ref"].get("needsReview") is True
          and wall["wall_ref"].get("reviewReason") == "plan_boundary_changed",
          "boundary topology change flags the persisted wall reference for review")
    return {"zone_count": 0, "anchor_count": 3, "edited_shape": changed}


def browser_tests(
    client: ApiClient,
    base_url: str,
    token: str,
    plan_id: str,
    suffix: str,
    expected: dict[str, Any],
    browser_path: Path,
    stage: str = "all",
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    # The running browser holds Crashpad files open on Windows.  Keep this
    # disposable profile until the process is closed during final cleanup;
    # attempting rmtree while unwinding would mask the useful test failure.
    # Keep the browser profile inside the workspace. Chromium's Windows
    # network sandbox cannot grant its child process access to some locked-down
    # system Temp ACLs, which otherwise makes CDP disconnect during startup.
    with contextlib.nullcontext(tempfile.mkdtemp(prefix="plan-editor-browser-", dir=ROOT)) as profile:
        print(f"INFO  launching browser regression stage={stage}", flush=True)
        process = subprocess.Popen(
            [
                str(browser_path), "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--remote-allow-origins=*",
                f"--remote-debugging-port={port}", f"--user-data-dir={profile}", "about:blank",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=(
                subprocess.CREATE_NEW_PROCESS_GROUP
                if os.name == "nt" else 0
            ),
        )
        cdp = None
        try:
            version_url = f"http://127.0.0.1:{port}/json/list"
            targets = wait_until(
                lambda: _json_url(version_url),
                "browser remote debugging endpoint",
                timeout=20,
            )
            print("INFO  browser remote debugging endpoint ready", flush=True)
            target = next(item for item in targets if item.get("type") == "page")
            cdp = Cdp(target["webSocketDebuggerUrl"])
            cdp.command("Runtime.enable")
            cdp.command("Page.enable")
            bootstrap = f"localStorage.setItem('tw_token', {json.dumps(token)});"
            cdp.command("Page.addScriptToEvaluateOnNewDocument", {"source": bootstrap})
            url = f"{base_url.rstrip('/')}/plan-editor.html?plan_id={quote(plan_id)}"
            cdp.command("Page.navigate", {"url": url})
            print("INFO  browser navigated to Plan Editor", flush=True)
            wait_until(
                lambda: cdp.evaluate("document.readyState === 'complete'"),
                "Plan Editor document load",
                timeout=20,
            )
            load_state = cdp.evaluate(
                "({editExists:Boolean(document.querySelector('#edit-plan'))),"
                "editDisabled:document.querySelector('#edit-plan')?.disabled,"
                "polygons:document.querySelectorAll('#plan-boundary-layer polygon').length,"
                "loading:document.querySelector('#editor-loading')?.textContent})"
            )
            print(f"INFO  Plan Editor DOM state {json.dumps(load_state, ensure_ascii=True)}", flush=True)
            wait_until(
                lambda: cdp.evaluate(
                    "Boolean(document.querySelector('#edit-plan') && !document.querySelector('#edit-plan').disabled && document.querySelectorAll('#plan-boundary-layer polygon').length)"
                ),
                "Plan Editor load",
                timeout=25,
            )
            print("INFO  Plan Editor finished loading", flush=True)
            check(cdp.evaluate("document.querySelectorAll('#plan-boundary-layer polygon')[0].points.numberOfItems") == 6,
                  "browser renders the six-vertex plan boundary")
            check(cdp.evaluate("document.querySelectorAll('#zone-layer g[data-kind=zone]').length") == expected["zone_count"],
                  "browser renders overlapping zones")
            check(cdp.evaluate("document.querySelectorAll('#anchor-layer g[data-kind=anchor]').length") == expected["anchor_count"],
                  "browser renders mount-aware anchors")
            check(cdp.evaluate("document.querySelector('#plan-area-output').value") == "376.000",
                  "browser plan inspector shows calculated polygon area")
            check(cdp.evaluate(
                "SUPALAI_PLAN_EDITOR.pointInPolygon({x:2,y:2},[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}])"
            ), "browser point-in-polygon logic recognizes an inside point")

            cdp.evaluate("document.querySelector('#edit-plan').click()")
            wait_until(lambda: not cdp.evaluate("document.querySelector('#save-plan').disabled"), "editor edit mode")
            toggle_result = cdp.evaluate(
                """(() => {
                  const ids=['tool-grid','tool-snap','tool-labels'];
                  const result={};
                  for (const id of ids) {
                    const button=document.getElementById(id), before=button.getAttribute('aria-pressed');
                    button.click(); const after=button.getAttribute('aria-pressed'); button.click();
                    result[id]=before !== after && button.getAttribute('aria-pressed') === before;
                  }
                  const svg=document.getElementById('editor-svg'), before=svg.getAttribute('viewBox');
                  document.getElementById('tool-zoom-in').click(); const zoomed=svg.getAttribute('viewBox');
                  document.getElementById('tool-fit').click();
                  return {toggles:Object.values(result).every(Boolean), zoom:before !== zoomed};
                })()"""
            )
            check(toggle_result["toggles"], "Grid, Snap and Labels toolbar toggles remain functional")
            check(toggle_result["zoom"], "Zoom and Fit controls update the SVG view")

            if stage == "zone":
                _browser_zone_anchor_tests(cdp, client, plan_id, suffix)
                return

            cdp.evaluate("document.querySelector('#tool-snap').click()")
            cdp.evaluate(
                """(() => {
                  const svg=document.getElementById('editor-svg'); svg.setPointerCapture=()=>{}; svg.releasePointerCapture=()=>{};
                  const polygon=document.querySelector('#plan-boundary-layer g[data-kind=boundary] polygon');
                  polygon.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:41}));
                  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:41}));
                })()"""
            )
            handle_count = cdp.evaluate("document.querySelectorAll('#plan-boundary-layer .vertex-handle').length")
            print(f"INFO  boundary vertex handles after selection: {handle_count}", flush=True)
            wait_until(lambda: cdp.evaluate("document.querySelectorAll('#plan-boundary-layer .vertex-handle').length") == 6,
                       "boundary vertex handles")
            cdp.evaluate(
                """(() => {
                  const svg=document.getElementById('editor-svg'), handle=document.querySelector('#plan-boundary-layer [data-vertex-index="5"]');
                  const polygon=document.querySelector('#plan-boundary-layer polygon');
                  const yMax=Math.max(...Array.from({length:polygon.points.numberOfItems},(_,i)=>polygon.points.getItem(i).y));
                  const toClient=(x,y)=>{const p=svg.createSVGPoint();p.x=x;p.y=yMax-y;return p.matrixTransform(svg.getScreenCTM())};
                  const start=handle.getBoundingClientRect(), a={x:start.left+start.width/2,y:start.top+start.height/2}, b=toClient(0,24);
                  handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:42,clientX:a.x,clientY:a.y}));
                  svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,button:0,pointerId:42,clientX:b.x,clientY:b.y}));
                  svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:42,clientX:b.x,clientY:b.y}));
                })()"""
            )
            wait_until(
                lambda: math.isclose(
                    client.call("GET", f"/api/plans/{plan_id}")["plan"]["area_m2"],
                    388.0,
                    abs_tol=1e-3,
                ),
                "dragged boundary vertex persistence",
                timeout=20,
            )
            check(True, "dragging a boundary vertex persists and recalculates area")
            resized_plan = client.call("GET", f"/api/plans/{plan_id}")["plan"]
            resized_project = client.call("GET", f"/api/projects/{resized_plan['project_id']}")
            print(
                "INFO  browser drag bounds "
                f"plan={resized_plan['width_m']}x{resized_plan['height_m']} "
                f"project={resized_project['width_m']}x{resized_project['height_m']}",
                flush=True,
            )
            check(math.isclose(resized_plan["width_m"], 20, abs_tol=1e-4)
                  and math.isclose(resized_plan["height_m"], 24, abs_tol=1e-4)
                  and math.isclose(resized_project["width_m"], resized_plan["width_m"], abs_tol=1e-9)
                  and math.isclose(resized_project["height_m"], resized_plan["height_m"], abs_tol=1e-9),
                  "browser vertex drag synchronizes plan and legacy project bounding boxes")
            cdp.evaluate("document.querySelector('#tool-undo').click()")
            wait_until(lambda: math.isclose(
                           client.call("GET", f"/api/plans/{plan_id}")["plan"]["area_m2"], 376.0, abs_tol=1e-3),
                       "boundary undo", timeout=20)
            cdp.evaluate("document.querySelector('#tool-redo').click()")
            wait_until(lambda: math.isclose(
                           client.call("GET", f"/api/plans/{plan_id}")["plan"]["area_m2"], 388.0, abs_tol=1e-3),
                       "boundary redo", timeout=20)
            check(True, "Undo/Redo restores vertex geometry through the API")

            if stage == "boundary":
                return

            _browser_zone_anchor_tests(cdp, client, plan_id, suffix)
            return
        finally:
            print("INFO  closing browser regression process", flush=True)
            # Cleanup is performed after the browser run has returned so a
            # Windows launcher process cannot interrupt exception reporting.
            if cdp is not None:
                with contextlib.suppress(Exception):
                    cdp.command("Browser.close")
                print("INFO  browser close command sent", flush=True)
                with contextlib.suppress(Exception):
                    cdp.close()
                print("INFO  browser debugging socket closed", flush=True)
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=10)
            print(f"INFO  browser launcher exit={process.poll()}", flush=True)
            if process.poll() is None:
                process.terminate()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=5)
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            shutil.rmtree(profile, ignore_errors=True)
            print("INFO  browser profile removed", flush=True)


def _draw_polygon(cdp: Cdp, tool_id: str, points: list[tuple[float, float]]) -> None:
    cdp.evaluate(f"document.getElementById({json.dumps(tool_id)}).click()")
    encoded = json.dumps(points)
    cdp.evaluate(
        f"""(() => {{const svg=document.getElementById('editor-svg');
        const polygon=document.querySelector('#plan-boundary-layer polygon');
        const yMax=Math.max(...Array.from({{length:polygon.points.numberOfItems}},(_,i)=>polygon.points.getItem(i).y));
        for (const [x,y] of {encoded}) {{const p=svg.createSVGPoint();p.x=x;p.y=yMax-y;const c=p.matrixTransform(svg.getScreenCTM());
        svg.dispatchEvent(new PointerEvent('pointerdown',{{bubbles:true,button:0,pointerId:71,clientX:c.x,clientY:c.y}}));}}
        svg.dispatchEvent(new MouseEvent('dblclick',{{bubbles:true,button:0}}));}})()"""
    )


def _browser_zone_anchor_tests(cdp: Cdp, client: ApiClient, plan_id: str, suffix: str) -> None:
    initial_zones = len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"])
    _draw_polygon(cdp, "tool-zone", [(2, 12), (8, 12), (8, 17), (2, 17)])
    wait_until(lambda: cdp.evaluate("Boolean(document.querySelector('.zone-name-modal'))"), "zone name modal")
    cdp.evaluate(
        f"""(() => {{const form=document.querySelector('.zone-name-modal');
        form.querySelector('[name=zone-name]').value={json.dumps('Browser Zone ' + suffix)}; form.requestSubmit();}})()"""
    )
    wait_until(lambda: len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"]) == initial_zones + 1,
               "browser-created freeform zone", timeout=20)
    check(True, "Zone tool closes and saves a freeform polygon")
    check(cdp.evaluate("document.querySelectorAll('#zone-list .zone-list-item').length") == initial_zones + 1,
          "Zone list displays all zones")

    cdp.evaluate("document.querySelector('#tool-duplicate').click()")
    wait_until(lambda: len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"]) == initial_zones + 2,
               "zone duplicate", timeout=20)
    cdp.evaluate("document.querySelector('#tool-undo').click()")
    wait_until(lambda: len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"]) == initial_zones + 1,
               "zone duplicate undo", timeout=20)
    check(not cdp.evaluate("document.querySelector('#tool-redo').disabled"),
          "Redo is available immediately after undoing a zone duplicate")

    initial_anchors = len(client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"])
    wall_id = f"BROWSER-WALL-{suffix}"
    cdp.evaluate(
        f"""(() => {{
          document.querySelector('#tool-anchor').click();
          const mount=document.querySelector('#anchor-mount-type-input'); mount.value='wall'; mount.dispatchEvent(new Event('change',{{bubbles:true}}));
          document.querySelector('#anchor-id-input').value={json.dumps(wall_id)};
          document.querySelector('#anchor-z-input').value='2.6';
          const svg=document.getElementById('editor-svg'), polygon=document.querySelector('#plan-boundary-layer polygon');
          const yMax=Math.max(...Array.from({{length:polygon.points.numberOfItems}},(_,i)=>polygon.points.getItem(i).y));
          const p=svg.createSVGPoint(); p.x=5;p.y=yMax-0.15;
          const c=p.matrixTransform(svg.getScreenCTM());
          svg.dispatchEvent(new PointerEvent('pointermove',{{bubbles:true,button:0,pointerId:51,clientX:c.x,clientY:c.y}}));
          svg.dispatchEvent(new PointerEvent('pointerdown',{{bubbles:true,button:0,pointerId:51,clientX:c.x,clientY:c.y}}));
        }})()"""
    )
    wait_until(lambda: len(client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"]) == initial_anchors + 1,
               "wall anchor placement", timeout=20)
    check(cdp.evaluate("document.querySelector('#tool-redo').disabled"),
          "a new anchor action clears the abandoned redo branch")
    zones_before_blocked_redo = len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"])
    cdp.evaluate("document.querySelector('#tool-redo').click()")
    time.sleep(0.25)
    check(len(client.call("GET", f"/api/plans/{plan_id}/zones")["zones"]) == zones_before_blocked_redo,
          "Redo cannot replay an action after Undo followed by a new action")
    check(True, "Duplicate, Undo and redo-branch invalidation work for zones")
    wall = next(row for row in client.call("GET", f"/api/plans/{plan_id}/anchors")["anchors"] if row["anchor_id"] == wall_id)
    check(abs(wall["y"]) < 1e-6 and wall["mount_type"] == "wall" and wall["wall_ref"]["edgeIndex"] == 0,
          "wall-mounted anchor snaps to the highlighted boundary edge")
    check(cdp.evaluate(f"Boolean(document.querySelector('#anchor-layer g[data-id={json.dumps(wall_id)}] .orientation-arrow'))"),
          "anchor orientation arrow renders on canvas")

    cdp.evaluate("document.querySelector('#tool-select').click()")
    cdp.evaluate(
        """(() => {const svg=document.getElementById('editor-svg');svg.setPointerCapture=()=>{};svg.releasePointerCapture=()=>{};
        const polygon=document.querySelector('#plan-boundary-layer polygon');
        const yMax=Math.max(...Array.from({length:polygon.points.numberOfItems},(_,i)=>polygon.points.getItem(i).y));
        const point=(x,y)=>{const p=svg.createSVGPoint();p.x=x;p.y=yMax-y;return p.matrixTransform(svg.getScreenCTM())};
        const a=point(0.5,0.5),b=point(14,18);
        svg.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:61,clientX:a.x,clientY:a.y}));
        svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,button:0,pointerId:61,clientX:b.x,clientY:b.y}));
        svg.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:61,clientX:b.x,clientY:b.y}));})()"""
    )
    wait_until(lambda: cdp.evaluate("document.querySelectorAll('.editor-entity.is-multi-selected').length") >= 2,
               "marquee multi-select")
    check(True, "marquee selection selects multiple editor objects")


def _json_url(url: str) -> Any:
    try:
        with urlopen(url, timeout=1) as response:
            return json.loads(response.read())
    except OSError:
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--browser", type=Path, default=DEFAULT_BROWSER)
    parser.add_argument("--skip-browser", action="store_true")
    parser.add_argument(
        "--browser-only",
        action="store_true",
        help="create a minimal fixture and run browser interactions without the full API integrity suite",
    )
    parser.add_argument(
        "--api-stage",
        choices=("all", "integrity"),
        default="all",
        help="run the full API suite or only the permanent data-integrity release gates",
    )
    parser.add_argument("--browser-stage", choices=("all", "boundary", "zone"), default="all")
    args = parser.parse_args()
    if args.skip_browser and args.browser_only:
        parser.error("--skip-browser and --browser-only cannot be used together")
    if not args.skip_browser and not args.browser.exists():
        raise SystemExit(f"Chrome/Edge browser not found: {args.browser}")

    database_url = dotenv_values(ROOT / "backend" / ".env").get("DATABASE_URL")
    if not database_url or "test" not in database_url.lower():
        raise SystemExit("Refusing to run: backend/.env DATABASE_URL is not clearly a test database")
    suffix = uuid.uuid4().hex[:8].upper()
    project_id = f"E2E-{suffix}"
    plan_id = f"PLAN-{suffix}"
    token = f"e2e-{uuid.uuid4().hex}"
    hardware_secret = (
        os.environ.get("HARDWARE_INGEST_SECRET")
        or dotenv_values(ROOT / "backend" / ".env").get("HARDWARE_INGEST_SECRET")
        or ""
    )
    if not args.browser_only and len(hardware_secret) < 32:
        raise SystemExit("HARDWARE_INGEST_SECRET must be at least 32 characters for the ingestion integrity test")
    connection = psycopg2.connect(database_url, connect_timeout=15, options="-c statement_timeout=20000")
    try:
        cleanup_stale_runs(connection)
        migration_checks(connection)
        create_test_session(connection, token)
        client = ApiClient(args.base_url, token)
        check(client.call("GET", "/api/me")["user"]["role"] == "admin", "temporary admin session authenticates through API")
        expected = (
            create_browser_fixture(client, project_id, plan_id, suffix)
            if args.browser_only
            else (
                api_integrity_tests(client, project_id, plan_id, suffix, hardware_secret)
                if args.api_stage == "integrity"
                else api_tests(client, project_id, plan_id, suffix, hardware_secret)
            )
        )
        if not args.skip_browser:
            browser_tests(client, args.base_url, token, plan_id, suffix, expected, args.browser, args.browser_stage)
        print("RESULT  all requested Plan Editor API/browser checks passed", flush=True)
        return 0
    finally:
        try:
            connection.rollback()
            with connection.cursor() as cursor:
                cursor.execute("DELETE FROM tags WHERE project_id = %s", (project_id,))
                cursor.execute("DELETE FROM projects WHERE id = %s", (project_id,))
                cursor.execute("DELETE FROM sessions WHERE token = %s", (token,))
            connection.commit()
            print(f"CLEAN  removed disposable project {project_id} and temporary session", flush=True)
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM projects WHERE id LIKE 'E2E-%'")
                e2e_projects = cursor.fetchone()[0]
                cursor.execute("SELECT count(*) FROM sessions WHERE token LIKE 'e2e-%'")
                e2e_sessions = cursor.fetchone()[0]
            print(f"CLEAN  e2e_projects={e2e_projects} e2e_sessions={e2e_sessions}", flush=True)
            if e2e_projects or e2e_sessions:
                raise AssertionError("disposable E2E database records remain after cleanup")
        finally:
            connection.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc(file=os.sys.stdout)
        raise
