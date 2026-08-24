"""Unit tests for backend/backend/calculations.py.

No database needed — pure geometry, so these run anywhere.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from calculations import analyze_coverage, suggest_anchor_layout  # noqa: E402


def test_small_room_gets_four_corner_anchors():
    anchors = suggest_anchor_layout(6, 6, margin_m=0.5, coverage_radius_m=12)
    assert len(anchors) == 4


def test_large_room_gets_more_than_four_anchors():
    anchors = suggest_anchor_layout(60, 40, margin_m=1, coverage_radius_m=12)
    assert len(anchors) > 4


def test_anchors_stay_within_bounds():
    anchors = suggest_anchor_layout(20, 15, margin_m=1, coverage_radius_m=12)
    for a in anchors:
        assert 0 <= a["x"] <= 20
        assert 0 <= a["y"] <= 15


def test_suggested_layout_beats_naive_four_corners_on_coverage():
    """The whole point of suggest_anchor_layout over a fixed 4-corner
    placeholder is better mid-room coverage on larger floor plans."""
    width, height, radius = 30, 20, 10

    four_corners = [
        {"anchor_id": "A01", "x": 1, "y": 1},
        {"anchor_id": "A02", "x": width - 1, "y": 1},
        {"anchor_id": "A03", "x": 1, "y": height - 1},
        {"anchor_id": "A04", "x": width - 1, "y": height - 1},
    ]
    suggested = suggest_anchor_layout(width, height, margin_m=1, coverage_radius_m=radius)

    cov_naive = analyze_coverage(four_corners, radius_m=radius, width_m=width, height_m=height)
    cov_suggested = analyze_coverage(suggested, radius_m=radius, width_m=width, height_m=height)

    assert cov_suggested["trilateration_ok_pct"] > cov_naive["trilateration_ok_pct"]


def test_coverage_percentages_sum_to_100():
    anchors = suggest_anchor_layout(20, 15, margin_m=1, coverage_radius_m=12)
    cov = analyze_coverage(anchors, radius_m=12, width_m=20, height_m=15)
    total = cov["trilateration_ok_pct"] + cov["weak_coverage_pct"] + cov["no_signal_pct"]
    assert abs(total - 100.0) < 0.2  # rounding tolerance


def test_no_anchors_means_all_no_signal():
    cov = analyze_coverage([], radius_m=10, width_m=20, height_m=15)
    assert cov["no_signal_pct"] == 100.0
    assert cov["trilateration_ok_pct"] == 0.0


def test_grid_size_is_capped_for_performance():
    anchors = suggest_anchor_layout(200, 200, margin_m=1, coverage_radius_m=12)
    cov = analyze_coverage(anchors, radius_m=12, width_m=200, height_m=200, resolution_m=0.1)
    assert cov["grid_points"] <= 160 * 160
