"""A rejected tag must not kill the simulator loop.

`tracking.ingest_fix` raises `TrackingPolicyError` when a tag stops being
simulator-owned — an admin retypes it to physical, or switches its project to
hardware mode. That can happen between the simulator's tag query and its write.

`Simulator._run` wraps its whole `while` loop in one `except Exception`, and
`start()` only creates a task when `self._task is None`, so an exception
escaping `_tick_once` ends the demo permanently with nothing but a log line.
These tests pin the two properties that prevent that: the rejection is
swallowed per tag, and the other tags in the same tick keep moving.

`simulator` imports `db`, which opens a connection pool at import time, so a
stub module stands in for it here.
"""
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

TAG_ROWS: list[dict[str, str]] = []


class FakeDB:
    """Just enough of the db surface for one simulator tick."""

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, str]]:
        return list(TAG_ROWS)

    def fetchone(self, sql: str, params: tuple = ()) -> dict | None:
        return None

    def execute(self, sql: str, params: tuple = ()) -> None:
        pass


if "db" not in sys.modules:
    stub = types.ModuleType("db")
    stub.db = FakeDB()
    stub.init_db = lambda: None
    stub.seed_demo_data = lambda: None
    sys.modules["db"] = stub

import queries as q  # noqa: E402
import tracking  # noqa: E402
from simulator import Simulator  # noqa: E402


def build_simulator(tag_ids: list[str]) -> Simulator:
    """A simulator with each tag already present, so a tick reaches ingest_fix."""
    TAG_ROWS[:] = [{"tag_id": tag_id, "project_id": "P001"} for tag_id in tag_ids]
    q.get_zones = lambda project_id: []
    # The tail of a tick also does the anchor heartbeat and the stale-visit
    # sweep; neither is under test here.
    q.get_projects = lambda: []
    q.get_anchors = lambda project_id=None, plan_id=None: []
    q.touch_anchors = lambda project_id: None
    tracking.sweep_stale_visits = lambda *args, **kwargs: 0

    simulator = Simulator()
    calls: list[str] = []
    tracking.ingest_fix = lambda tag_id, x, y, **kw: calls.append(tag_id)
    simulator._tick_once()  # creates the tag states
    for state in simulator._states.values():
        state.present = True
        state.present_ticks_left = 100
    simulator.calls = calls  # type: ignore[attr-defined]
    calls.clear()
    return simulator


def test_rejected_tag_does_not_escape_the_tick():
    simulator = build_simulator(["MOCK-1"])

    def refuse(tag_id, x, y, **kwargs):
        raise tracking.TagSourceMismatchError("tag is no longer a mock tag")

    tracking.ingest_fix = refuse
    simulator._tick_once()  # must not raise

    assert "MOCK-1" not in simulator._states, "the rejected tag should be dropped"


def test_one_rejected_tag_does_not_stop_the_others():
    simulator = build_simulator(["MOCK-1", "MOCK-2"])
    moved: list[str] = []

    def refuse_one(tag_id, x, y, **kwargs):
        if tag_id == "MOCK-1":
            raise tracking.ProjectModeMismatchError("project switched to hardware")
        moved.append(tag_id)

    tracking.ingest_fix = refuse_one
    simulator._tick_once()

    assert moved == ["MOCK-2"], "the surviving tag should still be moved"


def test_eligible_tag_is_moved_normally():
    simulator = build_simulator(["MOCK-1"])
    moved: list[str] = []
    tracking.ingest_fix = lambda tag_id, x, y, **kw: moved.append(tag_id)

    simulator._tick_once()

    assert moved == ["MOCK-1"]
    assert "MOCK-1" in simulator._states
