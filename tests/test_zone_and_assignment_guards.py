"""Two silent-failure guards in the ingest and assignment paths.

Both bugs these cover produced no error and no log line — one blanked the zone
on every fix, the other cut a visit in half — so they are worth pinning.

Patching here is deliberately explicit: every stub goes on the module under
test through `monkeypatch`, so it is undone afterwards and these tests do not
depend on which other test file ran first. (Do not reach for
`importlib.reload` to shed someone else's patch — it rebuilds `tracking`'s
exception classes, and the names `test_tracking_policy` already imported then
stop matching what the reloaded code raises.)
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


class RecordingDB:
    """Records whether the code under test reached SQL at all."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def fetchone(self, sql: str, params: tuple = ()) -> dict | None:
        self.calls.append(sql)
        return {"tag_id": "TAG01"}

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict]:
        self.calls.append(sql)
        return []

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.calls.append(sql)


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> RecordingDB:
    fake = RecordingDB()
    monkeypatch.setattr(q, "db", fake)
    return fake


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


def test_reassigning_the_same_thing_touches_nothing(
    monkeypatch: pytest.MonkeyPatch, recorder: RecordingDB
):
    monkeypatch.setattr(q, "get_tag", lambda tag_id: {
        "tag_id": tag_id, "project_id": "P001", "employee_id": "SALE001",
        "assignment_id": 7,
    })

    result = q.assign_tag("TAG01", "P001", "SALE001")

    assert result["tag_id"] == "TAG01"
    assert recorder.calls == [], "a no-op assignment must not reach the database"


def test_a_real_move_still_reaches_the_database(
    monkeypatch: pytest.MonkeyPatch, recorder: RecordingDB
):
    monkeypatch.setattr(q, "get_tag", lambda tag_id: {
        "tag_id": tag_id, "project_id": "P001", "employee_id": "SALE001",
        "assignment_id": 7,
    })

    q.assign_tag("TAG01", "P002", "SALE001")

    assert recorder.calls, "moving a tag to another project must be written"


def test_missing_assignment_history_is_repaired(
    monkeypatch: pytest.MonkeyPatch, recorder: RecordingDB
):
    # tags.project_id already matches, but no active tag_assignments row
    # exists, so the write must still happen.
    monkeypatch.setattr(q, "get_tag", lambda tag_id: {
        "tag_id": tag_id, "project_id": "P001", "employee_id": "SALE001",
        "assignment_id": None,
    })

    q.assign_tag("TAG01", "P001", "SALE001")

    assert recorder.calls, "a tag with no active assignment must get one written"
