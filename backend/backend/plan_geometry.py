"""Geometry helpers shared by plan APIs, tracking, and hardware ingestion.

Persisted editor polygons use the existing repository convention::

    {"type": "polygon", "points": [[x, y], ...]}

The parsers also accept ``{"x": ..., "y": ...}`` points so API callers can
use the more descriptive shape without creating a second storage format.
"""
from __future__ import annotations

import math
from typing import Any, Iterable


Point = tuple[float, float]


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalise_points(values: Any, *, minimum: int = 3) -> list[Point]:
    if not isinstance(values, list):
        raise ValueError("polygon points must be an array")

    points: list[Point] = []
    for value in values:
        if isinstance(value, dict):
            x = finite_number(value.get("x"))
            y = finite_number(value.get("y"))
        elif isinstance(value, (list, tuple)) and len(value) >= 2:
            x = finite_number(value[0])
            y = finite_number(value[1])
        else:
            x = y = None
        if x is None or y is None:
            raise ValueError("each polygon point must contain finite x and y values")
        if not points or (x, y) != points[-1]:
            points.append((x, y))

    # The closing edge is implicit in storage. Accept an explicitly repeated
    # first point from external clients, but do not persist it twice.
    if len(points) > 1 and points[0] == points[-1]:
        points.pop()
    if len(points) < minimum:
        raise ValueError(f"polygon must contain at least {minimum} distinct points")
    if abs(polygon_signed_area(points)) <= 1e-9:
        raise ValueError("polygon area must be greater than zero")
    return points


def polygon_geometry(points: Iterable[Point]) -> dict[str, Any]:
    return {
        "type": "polygon",
        "points": [[float(x), float(y)] for x, y in points],
    }


def normalise_polygon_geometry(geometry: Any) -> dict[str, Any]:
    if isinstance(geometry, list):
        values = geometry
    elif isinstance(geometry, dict):
        values = geometry.get("points")
    else:
        values = None
    return polygon_geometry(normalise_points(values))


def plan_boundary_fields(geometry: Any) -> dict[str, Any]:
    """Return the canonical boundary plus its legacy bounding-box fields.

    Keeping this calculation in one pure helper prevents API write paths from
    persisting a polygon while leaving ``width_m``/``height_m`` stale for
    tracking and older clients.
    """
    boundary = normalise_polygon_geometry(geometry)
    bounds = polygon_bounds(normalise_points(boundary["points"]))
    return {
        "boundary": boundary,
        "width_m": bounds["width_m"],
        "height_m": bounds["height_m"],
    }


def legacy_boundary(width_m: Any, height_m: Any) -> dict[str, Any]:
    width = finite_number(width_m) or 20.0
    height = finite_number(height_m) or 20.0
    width = max(width, 0.01)
    height = max(height, 0.01)
    return polygon_geometry([(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)])


def boundary_for_plan(plan: dict[str, Any] | None) -> dict[str, Any]:
    plan = plan or {}
    try:
        return normalise_polygon_geometry(plan.get("boundary"))
    except ValueError:
        return legacy_boundary(plan.get("width_m"), plan.get("height_m"))


def polygon_signed_area(points: Iterable[Point]) -> float:
    values = list(points)
    if len(values) < 3:
        return 0.0
    return sum(
        values[index][0] * values[(index + 1) % len(values)][1]
        - values[(index + 1) % len(values)][0] * values[index][1]
        for index in range(len(values))
    ) / 2.0


def polygon_area(points: Iterable[Point]) -> float:
    return abs(polygon_signed_area(points))


def polygon_bounds(points: Iterable[Point]) -> dict[str, float]:
    values = list(points)
    if not values:
        raise ValueError("polygon has no points")
    xs = [point[0] for point in values]
    ys = [point[1] for point in values]
    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)
    return {
        "x_min": x_min,
        "x_max": x_max,
        "y_min": y_min,
        "y_max": y_max,
        "width_m": x_max - x_min,
        "height_m": y_max - y_min,
    }


def point_on_segment(point: Point, start: Point, end: Point, epsilon: float = 1e-9) -> bool:
    cross = (point[1] - start[1]) * (end[0] - start[0]) - (point[0] - start[0]) * (end[1] - start[1])
    if abs(cross) > epsilon:
        return False
    return (
        min(start[0], end[0]) - epsilon <= point[0] <= max(start[0], end[0]) + epsilon
        and min(start[1], end[1]) - epsilon <= point[1] <= max(start[1], end[1]) + epsilon
    )


def point_in_polygon(point: Point, points: Iterable[Point]) -> bool:
    polygon = list(points)
    if len(polygon) < 3:
        return False
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if point_on_segment(point, previous, current):
            return True
        if (current[1] > point[1]) != (previous[1] > point[1]):
            crossing_x = (
                (previous[0] - current[0]) * (point[1] - current[1])
                / (previous[1] - current[1]) + current[0]
            )
            if point[0] < crossing_x:
                inside = not inside
        previous = current
    return inside


def nearest_point_on_segment(point: Point, start: Point, end: Point) -> tuple[Point, float]:
    dx, dy = end[0] - start[0], end[1] - start[1]
    length_squared = dx * dx + dy * dy
    if length_squared <= 1e-18:
        return start, 0.0
    ratio = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_squared
    ratio = min(1.0, max(0.0, ratio))
    return (start[0] + ratio * dx, start[1] + ratio * dy), ratio


def nearest_polygon_edge(point: Point, points: Iterable[Point]) -> dict[str, Any] | None:
    polygon = list(points)
    if len(polygon) < 2:
        return None
    best: dict[str, Any] | None = None
    for index, start in enumerate(polygon):
        end = polygon[(index + 1) % len(polygon)]
        projected, ratio = nearest_point_on_segment(point, start, end)
        distance = math.hypot(point[0] - projected[0], point[1] - projected[1])
        if best is None or distance < best["distance"]:
            best = {
                "edge_index": index,
                "point": projected,
                "offset_ratio": ratio,
                "distance": distance,
            }
    return best
