from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any, Protocol


logger = logging.getLogger("supalai.legacy_bridge")

CHECKPOINT_SOURCE = "public.positions_log"

# The bulk import in database/migrations/002_import_legacy_public_uwb.sql writes
# the same rows with this gateway_id and the same "positions-log:<log_id>"
# message_id. Deduplication between the two writers relies on the partial unique
# index on (gateway_id, message_id), so changing either value here means
# changing it there too — otherwise the replayed import silently re-inserts
# every fix this bridge has already forwarded.
GATEWAY_ID = "legacy-db"
TRACKING_SOURCES = {"hardware", "simulator"}


class DatabaseLike(Protocol):
    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None: ...

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]: ...

    def execute(self, sql: str, params: tuple = ()) -> None: ...


class LegacyBridgeError(RuntimeError):
    """The legacy stream cannot be forwarded without risking data loss."""


class LegacyBridge:
    """Tail the old UWB position table and feed the canonical ingest path.

    ``public.positions_log`` remains owned by the legacy UWB application. The
    dashboard migration provides a tag mapping and a durable checkpoint in the
    isolated ``supalai_dashboard`` schema. Processing one row at a time keeps
    the checkpoint behind any failed row. If the process stops after ingesting
    a fix but before moving the checkpoint, the stable gateway/message pair
    makes the retry idempotent inside ``tracking.ingest_fix``.
    """

    def __init__(
        self,
        database: DatabaseLike,
        ingest_fix: Callable[..., dict[str, Any]],
        *,
        poll_interval: float = 1.0,
        batch_size: int = 100,
    ) -> None:
        self._db = database
        self._ingest_fix = ingest_fix
        self._poll_interval = max(0.1, float(poll_interval))
        self._batch_size = max(1, min(1000, int(batch_size)))
        self._task: asyncio.Task[None] | None = None
        self._source_available: bool | None = None
        self._last_processed_id: int | None = None
        self._last_error: str | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "source_available": self._source_available,
            "last_processed_id": self._last_processed_id,
            "last_error": self._last_error,
        }

    def start(self) -> None:
        if self.running:
            return
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            # The task may already have died of its own accident; awaiting it
            # re-raises that. Shutdown is not the place to propagate it — doing
            # so would skip everything the caller still has to stop.
            logger.exception("legacy UWB bridge task ended with an error")

    def _detect_source(self) -> bool:
        row = self._db.fetchone(
            """
            SELECT
                to_regclass('public.positions_log') IS NOT NULL AS positions_log,
                to_regclass('supalai_dashboard.legacy_tag_map') IS NOT NULL AS tag_map,
                to_regclass('supalai_dashboard.legacy_import_state') IS NOT NULL AS import_state
            """
        )
        return bool(
            row
            and row.get("positions_log")
            and row.get("tag_map")
            and row.get("import_state")
        )

    def _checkpoint(self) -> int:
        row = self._db.fetchone(
            """
            SELECT last_id
            FROM supalai_dashboard.legacy_import_state
            WHERE source = %s
            """,
            (CHECKPOINT_SOURCE,),
        )
        if not row:
            raise LegacyBridgeError(
                f"missing checkpoint row for {CHECKPOINT_SOURCE!r}; "
                "run the legacy import migration before starting the bridge"
            )
        return int(row["last_id"])

    def _rows_after(self, checkpoint: int) -> list[dict[str, Any]]:
        return self._db.fetchall(
            """
            SELECT
                position.log_id,
                position.tag_id AS legacy_tag_id,
                position.x_pos::double precision AS x,
                position.y_pos::double precision AS y,
                position.anchors_used::integer AS anchors_used,
                (
                    COALESCE(
                        position.log_ts,
                        position.log_date
                            + COALESCE(position.log_time, time '00:00:00')
                    ) AT TIME ZONE 'Asia/Bangkok'
                ) AS recorded_at,
                mapping.dashboard_tag_id,
                mapping.dashboard_project_id,
                mapping.source AS tracking_source
            FROM public.positions_log AS position
            LEFT JOIN supalai_dashboard.legacy_tag_map AS mapping
              ON mapping.legacy_tag_id = position.tag_id
            WHERE position.log_id > %s
            ORDER BY position.log_id ASC
            LIMIT %s
            """,
            (checkpoint, self._batch_size),
        )

    def _advance_checkpoint(self, log_id: int) -> None:
        self._db.execute(
            """
            UPDATE supalai_dashboard.legacy_import_state
            SET last_id = %s, updated_at = now()
            WHERE source = %s AND last_id < %s
            """,
            (log_id, CHECKPOINT_SOURCE, log_id),
        )
        self._last_processed_id = log_id

    def _process_row(self, row: dict[str, Any]) -> None:
        log_id = int(row["log_id"])

        # The legacy schema permits incomplete diagnostic rows. They cannot be
        # positioned, but deliberately advancing past them avoids permanently
        # blocking every valid fix that follows.
        if row.get("x") is None or row.get("y") is None:
            logger.warning(
                "skipping legacy position %s for tag %s because x/y is null",
                log_id,
                row.get("legacy_tag_id"),
            )
            self._advance_checkpoint(log_id)
            return

        tag_id = row.get("dashboard_tag_id")
        project_id = row.get("dashboard_project_id")
        source = row.get("tracking_source")
        if not tag_id or not project_id:
            raise LegacyBridgeError(
                f"legacy position {log_id} uses unmapped tag {row.get('legacy_tag_id')}"
            )
        if source not in TRACKING_SOURCES:
            raise LegacyBridgeError(
                f"legacy position {log_id} has invalid mapped source {source!r}"
            )

        recorded_at = row.get("recorded_at")
        message_id = f"positions-log:{log_id}"
        try:
            self._ingest_fix(
                str(tag_id),
                float(row["x"]),
                float(row["y"]),
                ts=recorded_at,
                project_id=str(project_id),
                source=str(source),
                gateway_id=GATEWAY_ID,
                message_id=message_id,
                device_ts=recorded_at,
                anchors_used=(
                    int(row["anchors_used"])
                    if row.get("anchors_used") is not None
                    else None
                ),
            )
        except Exception as exc:
            raise LegacyBridgeError(
                f"failed to ingest legacy position {log_id} for dashboard tag {tag_id}"
            ) from exc

        self._advance_checkpoint(log_id)

    def _poll_once(self) -> int:
        checkpoint = self._checkpoint()
        rows = self._rows_after(checkpoint)
        for row in rows:
            # Intentionally stop at the first bad row. Advancing over it would
            # make that data loss permanent and would also reorder the stream.
            self._process_row(row)
        return len(rows)

    async def _run(self) -> None:
        try:
            self._source_available = await asyncio.to_thread(self._detect_source)
            if not self._source_available:
                logger.info(
                    "legacy UWB bridge inactive: public.positions_log or bridge metadata is absent"
                )
                return

            logger.info(
                "legacy UWB bridge started (interval=%.2fs, batch=%d)",
                self._poll_interval,
                self._batch_size,
            )
            while True:
                try:
                    await asyncio.to_thread(self._poll_once)
                    self._last_error = None
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._last_error = str(exc)
                    logger.exception("legacy UWB bridge poll failed")
                await asyncio.sleep(self._poll_interval)
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            # Anything raised outside the poll loop's own handler lands here —
            # in practice the _detect_source() probe at the top. Without this
            # the task would end while _last_error stayed None, so /health
            # would report a healthy bridge that is no longer running.
            self._last_error = str(exc)
            logger.exception("legacy UWB bridge stopped: startup detection failed")

