"""A silent-failure guard in the ingest path: zone falls back to the project.

The bug this covers produced no error and no log line — a fix landed with
zone = NULL whenever a plan existed but had not been given zones yet, which
silently emptied the dwell-time breakdown.

The `feat/legacy-db-bridge` version of this file also pinned an
`assign_tag`/`get_tag` no-op-reassignment guard, but this codebase does not
have those queries.py functions — tags are created and assigned inline in
main.py's `project_tag_create` endpoint instead. That guard does not port
here; if the same "reassigning the same thing should be a no-op" bug matters
for that endpoint, it needs its own test written against it directly.
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

# `db` opens a connection pool at import time, so a stub has to exist before
# anything imports it. Tests patch the module attributes they need instead of
# relying on whatever object happens to be in here.
if "db" not in sys.modules:
    stub = types.ModuleType("db")
    stub.db = None
    stub.init_db = lambda: None
    stub.seed_demo_data = lambda: None
    sys.modules["db"] = stub

import queries as q  # noqa: E402
import tracking  # noqa: E402

PROJECT_ZONES = [{"name": "Living Room", "x_min": 0, "x_max": 20, "y_min": 0, "y_max": 15}]


def ingest_capturing_zone(monkeypatch: pytest.MonkeyPatch, plan_zones: list[dict]) -> str | None:
    """Run one hardware fix and report the zone it decided to store."""
    captured: dict[str, object] = {}

    monkeypatch.setattr(q, "get_tracking_tag", lambda tag_id: {
        "tag_id": tag_id, "tag_type": "physical", "status": "active",
        "project_id": "P001", "employee_id": "SALE001",
    })
    monkeypatch.setattr(q, "get_project_tracking_mode", lambda project_id: "hardware")
    monkeypatch.setattr(q, "get_active_plan", lambda project_id: {"plan_id": "PLAN01"})
    monkeypatch.setattr(q, "get_plan_zones", lambda plan_id: list(plan_zones))
    monkeypatch.setattr(q, "get_zones", lambda project_id: list(PROJECT_ZONES))

    def fake_record(**kwargs):
        captured.update(kwargs)
        return {
            "tag_id": kwargs["tag_id"], "project_id": kwargs["project_id"],
            "plan_id": kwargs["plan_id"], "x": kwargs["x"], "y": kwargs["y"],
            "zone": kwargs["zone"], "source": kwargs["source"],
            "gateway_id": None, "message_id": None, "device_ts": None,
            "residual_m": None, "anchors_used": None, "ts": kwargs["ts"],
            "opened_visit_key": None,
        }

    monkeypatch.setattr(q, "record_position_fix", fake_record)
    tracking.ingest_fix("TAG01", 8.0, 6.0, project_id="P001", source="hardware")
    return captured["zone"]


def test_zone_falls_back_to_project_when_the_plan_has_none(monkeypatch: pytest.MonkeyPatch):
    # An admin activates a new plan before drawing its zones. Without the
    # fallback every fix stores zone = NULL and the dwell breakdown empties.
    assert ingest_capturing_zone(monkeypatch, plan_zones=[]) == "Living Room"


def test_plan_zones_still_win_when_present(monkeypatch: pytest.MonkeyPatch):
    plan_zones = [{"name": "Kitchen", "x_min": 0, "x_max": 20, "y_min": 0, "y_max": 15}]
    assert ingest_capturing_zone(monkeypatch, plan_zones=plan_zones) == "Kitchen"
