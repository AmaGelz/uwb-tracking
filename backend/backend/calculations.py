"""Anchor placement suggestions and coverage analysis.

Neither of these is a black box — they're the two calculations any UWB
installer does by hand when planning a site:

1. Where to put anchors (suggest_anchor_layout) so that most of the
   floor plan is within range of enough anchors.
2. Given a set of anchor positions, how much of the floor is actually
   covered well enough to trilaterate (analyze_coverage) — 2D
   trilateration needs >= 3 anchors in range of any given point;
   fewer than that and there's no fix, just a distance from a single
   anchor (a ring, not a point).
"""
from __future__ import annotations

import math


def suggest_anchor_layout(
    width_m: float,
    height_m: float,
    margin_m: float = 1.0,
    coverage_radius_m: float = 12.0,
) -> list[dict]:
    """Grid-based anchor placement.

    This is not a full DOP-optimizing solver (that's a constrained
    optimization problem in its own right) — it places anchors on a
    grid whose spacing is derived from coverage_radius_m so that most
    interior points stay within range of several anchors at once,
    with corners always anchored explicitly. Small rooms (where a
    single anchor's range roughly spans the room) naturally reduce to
    the classic 4-corner layout; larger rooms get intermediate anchors
    along the long edges so the middle of the room isn't only reachable
    by anchors clustered at the far corners.
    """
    width_m = max(float(width_m), 1.0)
    height_m = max(float(height_m), 1.0)
    margin_m = max(float(margin_m), 0.0)
    coverage_radius_m = max(float(coverage_radius_m), 1.0)

    w = max(width_m - 2 * margin_m, 0.1)
    h = max(height_m - 2 * margin_m, 0.1)

    # Spacing that keeps a point in the middle of a grid cell within
    # range of the anchors at its corners (cell diagonal <= 2 * radius,
    # with a safety factor since real environments attenuate signal).
    spacing = max(coverage_radius_m * 1.2, 2.0)

    nx = max(2, math.ceil(w / spacing) + 1)
    ny = max(2, math.ceil(h / spacing) + 1)

    xs = [margin_m + w * i / (nx - 1) for i in range(nx)]
    ys = [margin_m + h * j / (ny - 1) for j in range(ny)]

    anchors = []
    idx = 1
    for y in ys:
        for x in xs:
            anchors.append({"anchor_id": f"A{idx:02d}", "x": round(x, 2), "y": round(y, 2)})
            idx += 1

    return anchors


def analyze_coverage(
    anchors: list[dict],
    radius_m: float,
    width_m: float,
    height_m: float,
    resolution_m: float | None = None,
) -> dict:
    """Grid-sample the floor plan and classify each point by how many
    anchors are within radius_m of it.

    - >= 3 anchors in range -> a 2D trilateration fix is possible there
    - 1-2 anchors in range   -> only a distance-from-one-anchor ring, no fix
    - 0 anchors in range     -> dead zone
    """
    width_m = max(float(width_m), 0.1)
    height_m = max(float(height_m), 0.1)
    radius_m = max(float(radius_m), 0.1)

    if resolution_m is None:
        resolution_m = max(min(width_m, height_m) / 80, 0.25)
    resolution_m = max(float(resolution_m), 0.1)

    nx = max(2, int(width_m / resolution_m) + 1)
    ny = max(2, int(height_m / resolution_m) + 1)
    nx, ny = min(nx, 160), min(ny, 160)  # cap grid size so this stays fast

    pts = [(a["x"], a["y"]) for a in anchors]
    r2 = radius_m * radius_m

    total = ok3 = weak = none_ = 0
    gap_points: list[dict] = []

    for i in range(nx):
        x = width_m * i / (nx - 1)
        for j in range(ny):
            y = height_m * j / (ny - 1)
            count = sum(1 for ax, ay in pts if (ax - x) ** 2 + (ay - y) ** 2 <= r2)
            total += 1
            if count >= 3:
                ok3 += 1
            elif count >= 1:
                weak += 1
                if len(gap_points) < 200:
                    gap_points.append({"x": round(x, 2), "y": round(y, 2), "anchors_in_range": count})
            else:
                none_ += 1
                if len(gap_points) < 200:
                    gap_points.append({"x": round(x, 2), "y": round(y, 2), "anchors_in_range": 0})

    pct = lambda n: round(100 * n / total, 1) if total else 0.0

    return {
        "grid_resolution_m": round(resolution_m, 3),
        "grid_points": total,
        "trilateration_ok_pct": pct(ok3),
        "weak_coverage_pct": pct(weak),
        "no_signal_pct": pct(none_),
        "gap_points": gap_points,
        "gap_points_truncated": (weak + none_) > len(gap_points),
    }
