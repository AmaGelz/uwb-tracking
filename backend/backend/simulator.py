from __future__ import annotations

import asyncio
import logging
import random
from dataclasses import dataclass

from config import settings
from db import db
import queries as q
import tracking

logger = logging.getLogger("supalai.simulator")


@dataclass
class TagState:
    tag_id: str
    project_id: str
    present: bool = False
    x: float = 0.0
    y: float = 0.0
    target: tuple[float, float] = (0.0, 0.0)
    present_ticks_left: int = 0


def _pick_target(zones: list[dict]) -> tuple[float, float]:
    if not zones:
        return (1.0, 1.0)
    z = random.choice(zones)
    x_lo, x_hi = z["x_min"] + 0.3, max(z["x_max"] - 0.3, z["x_min"] + 0.3)
    y_lo, y_hi = z["y_min"] + 0.3, max(z["y_max"] - 0.3, z["y_min"] + 0.3)
    return (random.uniform(x_lo, x_hi), random.uniform(y_lo, y_hi))


def _step(x: float, y: float, target: tuple[float, float], step: float = 0.55) -> tuple[float, float]:
    tx, ty = target
    dx, dy = tx - x, ty - y
    dist = (dx * dx + dy * dy) ** 0.5
    if dist < step:
        return tx, ty
    return x + dx / dist * step, y + dy / dist * step


class Simulator:
    """Moves the demo tags around the seeded floor plan so the LIVE map,
    visit history, and analytics have real, moving data to show without
    physical UWB hardware connected.

    Disable with SIMULATOR_ENABLED=false in backend/.env once real
    anchors/tags are wired up. Real fixes come in through
    POST /api/positioning/{project_id}/ingest instead, which goes through
    the exact same tracking.ingest_fix() path this simulator uses — so
    turning this off and pointing real hardware at that endpoint is a
    drop-in swap, not a rewrite.
    """

    def __init__(self) -> None:
        self._states: dict[str, TagState] = {}
        self._task: asyncio.Task | None = None
        self._tick = 0

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())
            logger.info("simulator started (tick=%.1fs)", settings.simulator_tick_seconds)

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        try:
            while True:
                await asyncio.to_thread(self._tick_once)
                await asyncio.sleep(settings.simulator_tick_seconds)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("simulator loop crashed")

    def _tick_once(self) -> None:
        self._tick += 1

        tag_rows = db.fetchall(
            """
            SELECT t.tag_id, t.project_id
            FROM tags AS t
            JOIN projects AS p ON p.id = t.project_id
            WHERE t.project_id IS NOT NULL
              AND t.status = 'active'
              AND t.tag_type = 'mock'
              AND p.tracking_mode = 'simulation'
            """
        )
        eligible_tag_ids = {row["tag_id"] for row in tag_rows}
        for stale_tag_id in set(self._states) - eligible_tag_ids:
            self._states.pop(stale_tag_id, None)

        for row in tag_rows:
            tag_id, project_id = row["tag_id"], row["project_id"]
            zones = q.get_zones(project_id)

            state = self._states.get(tag_id)
            if state is None or state.project_id != project_id:
                start = _pick_target(zones)
                state = TagState(tag_id=tag_id, project_id=project_id, x=start[0], y=start[1])
                self._states[tag_id] = state

            if not state.present:
                # ~1 in 15 ticks, a tag that's away walks back in (avg ~15s at a 1s tick).
                if random.random() < 1 / 15:
                    state.present = True
                    state.target = _pick_target(zones)
                    state.present_ticks_left = random.randint(60, 600)  # ~1-10 minutes
                continue

            state.x, state.y = _step(state.x, state.y, state.target)
            if (abs(state.x - state.target[0]) < 0.15 and abs(state.y - state.target[1]) < 0.15
                    and random.random() < 1 / 8):
                state.target = _pick_target(zones)

            tracking.ingest_fix(
                tag_id,
                round(state.x, 3),
                round(state.y, 3),
                project_id=project_id,
                source="simulator",
            )

            state.present_ticks_left -= 1
            if state.present_ticks_left <= 0:
                state.present = False

        # Only simulated projects get synthetic anchor heartbeats. Hardware
        # projects must stay offline until their real gateway reports.
        for p in q.get_projects():
            if p["tracking_mode"] == "simulation" and q.get_anchors(p["project_id"]):
                q.touch_anchors(p["project_id"])

        if self._tick % 5 == 0:
            tracking.sweep_stale_visits()


simulator = Simulator()
