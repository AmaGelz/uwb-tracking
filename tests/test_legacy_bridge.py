"""Unit tests for the restart-safe public.positions_log compatibility bridge."""

from datetime import datetime, timezone
from decimal import Decimal
import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from legacy_bridge import (  # noqa: E402
    CHECKPOINT_SOURCE,
    GATEWAY_ID,
    LegacyBridge,
    LegacyBridgeError,
)


class FakeDatabase:
    def __init__(self, rows, checkpoint=0, available=True):
        self.rows = rows
        self.checkpoint = checkpoint
        self.available = available
        self.checkpoint_updates = []

    def fetchone(self, sql, params=()):
        if "to_regclass" in sql:
            return {
                "positions_log": self.available,
                "tag_map": self.available,
                "import_state": self.available,
            }
        if "SELECT last_id" in sql:
            return {"last_id": self.checkpoint}
        raise AssertionError(f"unexpected fetchone: {sql}")

    def fetchall(self, sql, params=()):
        checkpoint, limit = params
        return [row for row in self.rows if row["log_id"] > checkpoint][:limit]

    def execute(self, sql, params=()):
        log_id, source, guard_id = params
        assert source == CHECKPOINT_SOURCE
        assert log_id == guard_id
        if self.checkpoint < log_id:
            self.checkpoint = log_id
        self.checkpoint_updates.append(log_id)


def position_row(log_id=11, **overrides):
    row = {
        "log_id": log_id,
        "legacy_tag_id": 1,
        "x": Decimal("1.25"),
        "y": Decimal("2.50"),
        "anchors_used": 3,
        "recorded_at": datetime(2026, 9, 3, 3, 0, tzinfo=timezone.utc),
        "dashboard_tag_id": "tag0",
        "dashboard_project_id": "HW-1",
        "tracking_source": "hardware",
    }
    row.update(overrides)
    return row


def test_poll_forwards_fix_and_advances_checkpoint():
    database = FakeDatabase([position_row()])
    calls = []

    def ingest_fix(*args, **kwargs):
        calls.append((args, kwargs))
        return {"duplicate": False}

    bridge = LegacyBridge(database, ingest_fix, batch_size=50)

    assert bridge._poll_once() == 1
    assert database.checkpoint == 11
    assert database.checkpoint_updates == [11]

    args, kwargs = calls[0]
    assert args == ("tag0", 1.25, 2.5)
    assert kwargs["project_id"] == "HW-1"
    assert kwargs["source"] == "hardware"
    assert kwargs["gateway_id"] == GATEWAY_ID
    assert kwargs["message_id"] == "positions-log:11"
    assert kwargs["anchors_used"] == 3
    assert kwargs["ts"] == position_row()["recorded_at"]
    assert bridge.status()["last_processed_id"] == 11


def test_null_coordinates_are_logged_and_deliberately_skipped(caplog):
    database = FakeDatabase([position_row(x=None)])
    calls = []
    bridge = LegacyBridge(database, lambda *args, **kwargs: calls.append(args))

    with caplog.at_level("WARNING"):
        assert bridge._poll_once() == 1

    assert calls == []
    assert database.checkpoint == 11
    assert "x/y is null" in caplog.text


def test_unmapped_tag_blocks_stream_without_advancing_checkpoint():
    database = FakeDatabase(
        [
            position_row(dashboard_tag_id=None, dashboard_project_id=None),
            position_row(log_id=12),
        ]
    )
    calls = []
    bridge = LegacyBridge(database, lambda *args, **kwargs: calls.append(args))

    with pytest.raises(LegacyBridgeError, match="unmapped tag"):
        bridge._poll_once()

    assert database.checkpoint == 0
    assert database.checkpoint_updates == []
    assert calls == []


def test_failed_ingest_is_retryable_and_does_not_advance_checkpoint():
    database = FakeDatabase([position_row()])

    def fail(*args, **kwargs):
        raise RuntimeError("database temporarily unavailable")

    bridge = LegacyBridge(database, fail)

    with pytest.raises(LegacyBridgeError, match="failed to ingest"):
        bridge._poll_once()

    assert database.checkpoint == 0
    assert database.checkpoint_updates == []


def test_source_auto_detection_requires_all_three_tables():
    available = LegacyBridge(FakeDatabase([], available=True), lambda *args, **kwargs: {})
    unavailable = LegacyBridge(FakeDatabase([], available=False), lambda *args, **kwargs: {})

    assert available._detect_source() is True
    assert unavailable._detect_source() is False

