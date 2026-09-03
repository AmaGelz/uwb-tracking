"""API-level normalization contracts for legacy Plan Editor payloads."""
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

import main  # noqa: E402


L_SHAPE = {
    "type": "polygon",
    "points": [[0, 0], [20, 0], [20, 14], [12, 14], [12, 20], [0, 20]],
}


def test_legacy_size_update_cannot_replace_existing_freeform_boundary():
    result = main.normalise_plan_data(
        {"width_m": 99, "height_m": 88},
        {"boundary": L_SHAPE, "width_m": 20, "height_m": 20},
    )

    assert result["boundary"]["points"] == L_SHAPE["points"]
    assert result["width_m"] == 20
    assert result["height_m"] == 20


def test_legacy_mount_height_populates_z_without_losing_height():
    result = main.normalise_anchor_data(
        {"project_id": "P1", "plan_id": "PLAN1", "ceiling_height_m": 3},
        {
            "anchor_id": "A1", "x": 1, "y": 2,
            "mount_type": "free", "mount_height_m": 2.35,
        },
    )

    assert result["z"] == pytest.approx(2.35)
    assert result["mount_height_m"] == pytest.approx(2.35)


def test_unchanged_boundary_does_not_invalidate_wall_references(monkeypatch):
    current = {
        "plan_id": "PLAN1", "project_id": "P1", "name": "Floor 1",
        "boundary": L_SHAPE, "width_m": 20, "height_m": 20,
        "ceiling_height_m": 3, "is_active": True, "version": 1,
    }
    captured = {}
    monkeypatch.setattr(main, "require_role", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "require_plan", lambda _plan_id: current)

    def update(_plan_id, data):
        captured.update(data)
        return current

    monkeypatch.setattr(main.q, "update_plan", update)
    main.plan_update("PLAN1", main.PlanUpdate(name="Renamed", boundary=L_SHAPE), "token")

    assert captured["name"] == "Renamed"
    assert "boundary" not in captured


def test_dimension_coordinate_update_recalculates_derived_values(monkeypatch):
    captured = {}
    existing = {
        "dimension_id": 7, "plan_id": "PLAN1",
        "x1": 0, "y1": 0, "x2": 3, "y2": 4,
        "length_m": 5, "angle_deg": math.degrees(math.atan2(4, 3)),
        "label": None, "created_at": None, "updated_at": None,
    }

    monkeypatch.setattr(main, "require_role", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "require_plan", lambda _plan_id: {"plan_id": "PLAN1"})
    monkeypatch.setattr(main.q, "get_plan_dimensions", lambda _plan_id: [existing])

    def update(_plan_id, _dimension_id, data):
        captured.update(data)
        return data

    monkeypatch.setattr(main.q, "update_plan_dimension", update)
    main.plan_dimension_update("PLAN1", 7, main.PlanDimensionUpdate(x2=6, y2=8), "token")

    assert captured["length_m"] == pytest.approx(10)
    assert captured["angle_deg"] == pytest.approx(math.degrees(math.atan2(8, 6)))
