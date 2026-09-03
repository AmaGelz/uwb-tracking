"""Regression tests for freeform plan, zone, and wall geometry."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from plan_geometry import (  # noqa: E402
    boundary_for_plan,
    nearest_polygon_edge,
    normalise_points,
    normalise_polygon_geometry,
    plan_boundary_fields,
    point_in_polygon,
    polygon_area,
    polygon_bounds,
)


L_SHAPE = [(0, 0), (20, 0), (20, 14), (12, 14), (12, 20), (0, 20)]


def test_l_shaped_plan_keeps_all_vertices_area_and_bounds():
    geometry = normalise_polygon_geometry({"type": "polygon", "points": L_SHAPE})
    points = normalise_points(geometry["points"])

    assert len(points) == 6
    assert polygon_area(points) == pytest.approx(352.0)
    assert polygon_bounds(points) == {
        "x_min": 0.0,
        "x_max": 20.0,
        "y_min": 0.0,
        "y_max": 20.0,
        "width_m": 20.0,
        "height_m": 20.0,
    }


def test_boundary_fields_keep_legacy_width_and_height_in_sync():
    fields = plan_boundary_fields({
        "type": "polygon",
        "points": [(0, 0), (20, 0), (20, 14), (12, 14), (12, 24), (0, 24)],
    })

    assert fields["width_m"] == 20.0
    assert fields["height_m"] == 24.0
    assert len(fields["boundary"]["points"]) == 6


def test_concave_cutout_is_outside_but_edges_count_as_inside():
    assert point_in_polygon((5, 5), L_SHAPE)
    assert not point_in_polygon((16, 17), L_SHAPE)
    assert point_in_polygon((12, 17), L_SHAPE)


def test_legacy_width_height_becomes_closed_implicit_rectangle():
    boundary = boundary_for_plan({"width_m": 6.5, "height_m": 4})
    assert boundary == {
        "type": "polygon",
        "points": [[0.0, 0.0], [6.5, 0.0], [6.5, 4.0], [0.0, 4.0]],
    }


def test_object_points_and_explicit_closing_vertex_are_normalised():
    points = normalise_points([
        {"x": 0, "y": 0}, {"x": 4, "y": 0}, {"x": 4, "y": 3},
        {"x": 0, "y": 3}, {"x": 0, "y": 0},
    ])
    assert points == [(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)]


def test_wall_projection_returns_edge_and_offset_ratio():
    nearest = nearest_polygon_edge((5, 0.2), [(0, 0), (20, 0), (20, 10), (0, 10)])
    assert nearest is not None
    assert nearest["edge_index"] == 0
    assert nearest["point"] == pytest.approx((5.0, 0.0))
    assert nearest["offset_ratio"] == pytest.approx(0.25)
    assert nearest["distance"] == pytest.approx(0.2)


@pytest.mark.parametrize("points", [[], [[0, 0], [1, 1], [2, 2]], [[0, 0], [1, "bad"], [0, 1]]])
def test_invalid_polygons_are_rejected(points):
    with pytest.raises(ValueError):
        normalise_points(points)
