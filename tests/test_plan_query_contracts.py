"""Keep dynamically assembled Plan Editor SQL parameters in sync."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "migration"))

import queries  # noqa: E402
import postgres_to_postgres  # noqa: E402


ROOT = Path(__file__).resolve().parents[1]


class ParameterCheckingDB:
    def _check(self, sql, params=()):
        assert sql.count("%s") == len(params), (sql, params)
        return None

    fetchone = _check
    execute_returning = _check


class CapturingPlanDB(ParameterCheckingDB):
    def __init__(self):
        self.fetchone_calls = []
        self.execute_calls = []

    def fetchone(self, sql, params=()):
        self._check(sql, params)
        self.fetchone_calls.append((sql, params))
        return {
            "plan_id": "PLAN1", "project_id": "P1", "name": "Floor 1",
            "width_m": 20, "height_m": 24,
            "boundary": {"type": "polygon", "points": [[0, 0], [20, 0], [20, 24], [0, 24]]},
            "ceiling_height_m": 3, "is_active": True, "version": 1,
            "created_at": None, "updated_at": None,
        }

    def execute(self, sql, params=()):
        self._check(sql, params)
        self.execute_calls.append((sql, params))


def test_create_mutation_placeholder_counts(monkeypatch):
    monkeypatch.setattr(queries, "db", ParameterCheckingDB())

    queries.create_plan("P1", {
        "plan_id": "PLAN1", "name": "Floor 1", "width_m": 20,
        "height_m": 20, "boundary": {"type": "polygon", "points": [[0, 0], [20, 0], [20, 20], [0, 20]]},
        "ceiling_height_m": 3, "is_active": True, "version": 1,
    })
    queries.create_plan_zone("PLAN1", {
        "name": "Reception", "x_min": 0, "x_max": 5, "y_min": 0, "y_max": 4,
        "geometry": {"type": "polygon", "points": [[0, 0], [5, 0], [5, 4], [0, 4]]},
        "zone_type": "waiting_area", "color": "#4F9DDE", "opacity": 0.3,
        "is_visible": True,
    })
    queries.create_plan_anchor("PLAN1", {
        "anchor_id": "A1", "hardware_address": "1782", "x": 2, "y": 0,
        "z": 2.5, "mount_height_m": 2.5, "mount_type": "wall",
        "orientation_deg": 90, "wall_ref": {"edgeIndex": 0, "offsetRatio": 0.1},
    })


def test_update_mutation_placeholder_counts(monkeypatch):
    monkeypatch.setattr(queries, "db", ParameterCheckingDB())

    queries.update_plan("PLAN1", {
        "boundary": {"type": "polygon", "points": [[0, 0], [5, 0], [5, 5], [0, 5]]},
        "width_m": 5, "height_m": 5,
    })
    queries.update_plan_zone("PLAN1", 1, {
        "geometry": {"type": "polygon", "points": [[0, 0], [3, 0], [0, 3]]},
        "color": "#123456", "opacity": 0.5,
    })
    queries.update_plan_dimension("PLAN1", 1, {
        "x1": 0, "y1": 0, "x2": 2, "y2": 2, "length_m": 2.828,
    })


def test_boundary_update_flags_boundary_wall_refs_and_syncs_legacy_project(monkeypatch):
    fake = CapturingPlanDB()
    monkeypatch.setattr(queries, "db", fake)

    queries.update_plan("PLAN1", {
        "boundary": {"type": "polygon", "points": [[0, 0], [20, 0], [20, 24], [0, 24]]},
        "width_m": 20,
        "height_m": 24,
    })

    update_sql, update_params = fake.fetchone_calls[0]
    assert "anchor_review AS" in update_sql
    assert "'needsReview', true" in update_sql
    assert "'reviewReason', 'plan_boundary_changed'" in update_sql
    assert update_params[-1] is True
    sync_sql, sync_params = fake.execute_calls[0]
    assert "width_m = selected.width_m" in sync_sql
    assert "height_m = selected.height_m" in sync_sql
    assert sync_params == ("P1", "P1")


def test_non_boundary_plan_update_does_not_flag_wall_refs(monkeypatch):
    fake = CapturingPlanDB()
    monkeypatch.setattr(queries, "db", fake)

    queries.update_plan("PLAN1", {"name": "Renamed floor"})

    _sql, params = fake.fetchone_calls[0]
    assert params[-1] is False


def test_hardware_ingest_anchor_update_preserves_mount_metadata():
    sql = (ROOT / "database" / "migrations" / "002_hardware_ingest.sql").read_text(encoding="utf-8")
    match = re.search(
        r"UPDATE anchors AS anchor SET(?P<assignments>.*?)FROM jsonb_to_recordset",
        sql,
        flags=re.DOTALL | re.IGNORECASE,
    )
    assert match, "ingest_hardware_fix must contain the scoped anchor status update"
    assignments = match.group("assignments").lower()
    assert "battery =" in assignments
    assert "last_ts =" in assignments
    for protected in ("mount_type", "orientation_deg", "wall_ref", "z", "x", "y"):
        assert not re.search(rf"\b{protected}\s*=", assignments)


def test_new_command_invalidates_the_redo_branch_contract():
    source = (ROOT / "SUPALAI-UWB-frontend" / "js" / "plan-editor.js").read_text(encoding="utf-8")
    body = source.split("function recordCommand", 1)[1].split("async function undo", 1)[0]
    assert "state.undoStack.push" in body
    assert "state.redoStack = []" in body
    assert "updateHistoryButtons()" in body


def test_database_copy_orders_hardware_bindings_before_anchors():
    tables = list(postgres_to_postgres.TABLE_COLUMNS)
    assert tables.index("plans") < tables.index("hardware_gateways")
    assert tables.index("hardware_gateways") < tables.index("tags")
    assert tables.index("tags") < tables.index("anchors")
    assert "gateway_device_id" in postgres_to_postgres.TABLE_COLUMNS["anchors"]
    assert "bound_tag_id" in postgres_to_postgres.TABLE_COLUMNS["anchors"]


def test_manual_supabase_migration_preserves_freeform_editor_metadata():
    sql = (ROOT / "migration" / "supabase_manual_data_migration.sql").read_text(encoding="utf-8")
    required_fragments = (
        "to_jsonb(p) -> 'boundary'",
        "to_jsonb(p) ->> 'ceiling_height_m'",
        "to_jsonb(z) ->> 'zone_type'",
        "to_jsonb(a) ->> 'mount_type'",
        "to_jsonb(a) ->> 'orientation_deg'",
        "to_jsonb(a) -> 'wall_ref'",
        "to_jsonb(a) ->> 'gateway_device_id'",
        "to_jsonb(a) ->> 'bound_tag_id'",
    )
    for fragment in required_fragments:
        assert fragment in sql
    assert sql.index("INSERT INTO public.hardware_gateways") < sql.index("INSERT INTO public.tags")
    assert sql.index("INSERT INTO public.tags") < sql.index("INSERT INTO public.anchors")


def test_rollback_restores_legacy_anchor_z_contract():
    sql = (ROOT / "database" / "rollbacks" / "005_plan_editor_freeform.sql").read_text(encoding="utf-8")
    assert "ALTER COLUMN z DROP NOT NULL" in sql
    assert "ALTER COLUMN z DROP DEFAULT" in sql
    assert "SELECT id, project_id, plan_id, anchor_id, z, mount_height_m" in sql
