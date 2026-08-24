"""2D multilateration for UWB tag positioning.

Real UWB hardware (e.g. DW1000/DW3000-based anchors) measures the
distance between a tag and each anchor it can hear via two-way ranging
(TWR), not an angle or a raw coordinate. Turning >=3 of those distances
into an (x, y) position is what this module does.

The math: linearize the system of circle equations
    (x - x_i)^2 + (y - y_i)^2 = d_i^2
by subtracting a reference anchor's equation from every other one. That
cancels the quadratic x^2/y^2 terms and leaves a linear system solvable
with ordinary least squares — the standard approach for multilateration
with 3+ anchors (with 3 anchors it reduces to an exact solve; with more
it becomes a least-squares fit that also cancels out ranging noise,
which is why real installs use 4+ anchors rather than the minimum 3).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class Fix:
    x: float
    y: float
    residual_m: float  # RMS distance error between the fit and the raw ranges — a rough fix-quality score
    anchors_used: int


def trilaterate(anchor_positions: list[tuple[float, float]], distances: list[float]) -> Fix | None:
    n = len(anchor_positions)
    if n < 3 or len(distances) != n:
        return None
    if any(d <= 0 for d in distances):
        return None

    xr, yr = anchor_positions[-1]
    dr = distances[-1]

    A = []
    b = []
    for (xi, yi), di in zip(anchor_positions[:-1], distances[:-1]):
        A.append([2 * (xr - xi), 2 * (yr - yi)])
        b.append(di**2 - dr**2 - xi**2 - yi**2 + xr**2 + yr**2)

    A = np.array(A, dtype=float)
    b = np.array(b, dtype=float)

    try:
        solution, *_ = np.linalg.lstsq(A, b, rcond=None)
    except np.linalg.LinAlgError:
        return None

    x, y = float(solution[0]), float(solution[1])

    errs = [
        math.hypot(xi - x, yi - y) - di
        for (xi, yi), di in zip(anchor_positions, distances)
    ]
    rms = math.sqrt(sum(e * e for e in errs) / len(errs))

    return Fix(x=x, y=y, residual_m=round(rms, 4), anchors_used=n)


def simulate_range(true_pos: tuple[float, float], anchor_pos: tuple[float, float], noise_m: float = 0.0) -> float:
    """Distance a real anchor would report for a tag at true_pos, plus optional ranging noise.

    Used by the demo simulator so /api/positioning ingestion has
    something realistic to solve, and by tests to sanity-check trilaterate().
    """
    d = math.hypot(true_pos[0] - anchor_pos[0], true_pos[1] - anchor_pos[1])
    if noise_m:
        d += np.random.normal(0, noise_m)
    return max(d, 0.01)
