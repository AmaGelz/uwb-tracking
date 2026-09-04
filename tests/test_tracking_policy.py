"""Unit tests for the physical/mock boundary in backend/backend/tracking.py.

`validate_tracking_policy` is the one place that decides whether a fix is
allowed to touch the database: real hardware may only report physical tags in
a hardware project, and the simulator may only move mock tags in a simulation
project. Getting that wrong would mix demo data into real visit history, so it
is worth testing without a database.

`tracking` imports `db`, which opens a connection pool at import time, so a
stub module stands in for it here.
"""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

if "db" not in sys.modules:
    stub = types.ModuleType("db")
    stub.db = None
    stub.init_db = lambda: None
    stub.seed_demo_data = lambda: None
    sys.modules["db"] = stub

from tracking import (  # noqa: E402
    InactiveTagError,
    ProjectModeMismatchError,
    TagProjectMismatchError,
    TagSourceMismatchError,
    TrackingPolicyError,
    UnknownTagError,
    validate_tracking_policy,
)

PHYSICAL = {"tag_id": "UWB-0001", "tag_type": "physical", "status": "active", "project_id": "P900"}
MOCK = {"tag_id": "TAG01", "tag_type": "mock", "status": "active", "project_id": "P001"}


def test_hardware_fix_for_a_physical_tag_in_a_hardware_project():
    assert validate_tracking_policy(PHYSICAL, "P900", "hardware", "hardware") == "P900"


def test_simulator_fix_for_a_mock_tag_in_a_simulation_project():
    assert validate_tracking_policy(MOCK, "P001", "simulator", "simulation") == "P001"


def test_project_may_be_left_to_the_active_assignment():
    assert validate_tracking_policy(PHYSICAL, None, "hardware", "hardware") == "P900"


def test_unknown_tag_is_rejected():
    with pytest.raises(UnknownTagError):
        validate_tracking_policy(None, "P900", "hardware", "hardware")


def test_disabled_tag_is_rejected():
    disabled = {**PHYSICAL, "status": "disabled"}
    with pytest.raises(InactiveTagError):
        validate_tracking_policy(disabled, "P900", "hardware", "hardware")


def test_unassigned_tag_is_rejected():
    unassigned = {**PHYSICAL, "project_id": None}
    with pytest.raises(TagProjectMismatchError):
        validate_tracking_policy(unassigned, "P900", "hardware", "hardware")


def test_fix_for_another_project_is_rejected():
    with pytest.raises(TagProjectMismatchError):
        validate_tracking_policy(PHYSICAL, "P001", "hardware", "hardware")


def test_simulator_cannot_move_a_physical_tag():
    with pytest.raises(TagSourceMismatchError):
        validate_tracking_policy(PHYSICAL, "P900", "simulator", "simulation")


def test_gateway_cannot_report_a_mock_tag():
    with pytest.raises(TagSourceMismatchError):
        validate_tracking_policy(MOCK, "P001", "hardware", "hardware")


@pytest.mark.parametrize("mode", ["simulation", "disabled", None])
def test_hardware_fix_needs_a_hardware_project(mode):
    with pytest.raises(ProjectModeMismatchError):
        validate_tracking_policy(PHYSICAL, "P900", "hardware", mode)


@pytest.mark.parametrize("mode", ["hardware", "disabled", None])
def test_simulator_fix_needs_a_simulation_project(mode):
    with pytest.raises(ProjectModeMismatchError):
        validate_tracking_policy(MOCK, "P001", "simulator", mode)


def test_unknown_source_is_rejected_before_anything_else():
    with pytest.raises(TrackingPolicyError):
        validate_tracking_policy(PHYSICAL, "P900", "guess", "hardware")
