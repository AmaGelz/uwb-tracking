"""Regression coverage for the dashboard heatmap response contract."""
from datetime import datetime, timezone
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

import queries  # noqa: E402


def epoch(hour: int) -> float:
    return datetime(2026, 9, 3, hour, tzinfo=timezone.utc).timestamp()


def test_heatmap_returns_zone_rows_with_hour_cells(monkeypatch):
    monkeypatch.setattr(queries, "get_visits", lambda _filters: [
        {"start_ts": epoch(8), "duration": 120, "top_zone": "Reception"},
        {"start_ts": epoch(8), "duration": 30, "top_zone": "Reception"},
        {"start_ts": epoch(10), "duration": 90, "top_zone": "Showroom"},
        {"start_ts": epoch(11), "duration": None, "top_zone": "Open visit"},
    ])

    result = queries.get_heatmap({})

    assert result["hours"] == list(range(24))
    assert [row["zone"] for row in result["rows"]] == ["Reception", "Showroom"]
    assert all(len(row["cells"]) == 24 for row in result["rows"])
    assert result["rows"][0]["cells"][8] == 150
    assert result["rows"][0]["total"] == 150
    assert result["peak"] == 150


def test_empty_heatmap_still_has_a_complete_safe_shape(monkeypatch):
    monkeypatch.setattr(queries, "get_visits", lambda _filters: [])

    result = queries.get_heatmap({})

    assert result == {"ok": True, "hours": list(range(24)), "rows": [], "peak": 1.0}
