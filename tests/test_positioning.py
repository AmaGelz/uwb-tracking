"""Unit tests for backend/backend/positioning.py.

No database needed — pure math, so these run anywhere.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from positioning import simulate_range, trilaterate  # noqa: E402

ANCHORS = [(1.0, 1.0), (19.0, 1.0), (1.0, 14.0), (19.0, 14.0)]


def test_exact_recovery_with_three_anchors():
    true_pos = (8.2, 6.4)
    dists = [simulate_range(true_pos, a) for a in ANCHORS[:3]]
    fix = trilaterate(ANCHORS[:3], dists)
    assert fix is not None
    assert fix.x == pytest.approx(true_pos[0], abs=1e-6)
    assert fix.y == pytest.approx(true_pos[1], abs=1e-6)
    assert fix.residual_m == pytest.approx(0.0, abs=1e-6)


def test_least_squares_fit_with_noisy_four_anchors():
    true_pos = (10.0, 5.0)
    dists = [simulate_range(true_pos, a, noise_m=0.05) for a in ANCHORS]
    fix = trilaterate(ANCHORS, dists)
    assert fix is not None
    # Small ranging noise should still land within ~1m of the true position.
    assert abs(fix.x - true_pos[0]) < 1.0
    assert abs(fix.y - true_pos[1]) < 1.0
    assert fix.anchors_used == 4


def test_returns_none_with_fewer_than_three_anchors():
    assert trilaterate(ANCHORS[:2], [1.0, 2.0]) is None


def test_returns_none_on_mismatched_lengths():
    assert trilaterate(ANCHORS, [1.0, 2.0]) is None


def test_rejects_nonpositive_distance():
    assert trilaterate(ANCHORS[:3], [1.0, 0.0, 2.0]) is None


def test_points_near_room_center_recover_well():
    # A point in the middle of the 20x15 demo room, using all 4 corner anchors.
    true_pos = (10.0, 7.5)
    dists = [simulate_range(true_pos, a) for a in ANCHORS]
    fix = trilaterate(ANCHORS, dists)
    assert fix.x == pytest.approx(true_pos[0], abs=1e-4)
    assert fix.y == pytest.approx(true_pos[1], abs=1e-4)
