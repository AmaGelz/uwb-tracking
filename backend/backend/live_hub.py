from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from fastapi import WebSocket


logger = logging.getLogger("supalai.live")


def session_token_from_protocol_header(header: str) -> str | None:
    protocols = [value.strip() for value in header.split(",")]
    if "supalai.live" not in protocols:
        return None
    for protocol in protocols:
        if protocol.startswith("session."):
            return protocol.removeprefix("session.") or None
    return None


class LiveHub:
    """Fan out changed tag snapshots to every connected dashboard client."""

    def __init__(self, snapshot_provider: Callable[[], dict[str, Any]], interval: float = 0.25) -> None:
        self._snapshot_provider = snapshot_provider
        self._interval = interval
        self._clients: set[WebSocket] = set()
        self._has_clients: asyncio.Event | None = None
        self._task: asyncio.Task[None] | None = None
        self._last_fingerprint: str | None = None

    @property
    def client_count(self) -> int:
        return len(self._clients)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._has_clients = asyncio.Event()
            if self._clients:
                self._has_clients.set()
            self._task = asyncio.create_task(self._run(), name="live-websocket-broadcaster")
            logger.info("live WebSocket broadcaster started (interval=%.3fs)", self._interval)

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        clients = list(self._clients)
        self._clients.clear()
        if self._has_clients is not None:
            self._has_clients.clear()
        self._has_clients = None
        self._last_fingerprint = None
        if clients:
            await asyncio.gather(
                *(client.close(code=1012, reason="Server shutting down") for client in clients),
                return_exceptions=True,
            )
        logger.info("live WebSocket broadcaster stopped")

    async def connect(self, websocket: WebSocket) -> None:
        """Accept and send the required initial snapshot before joining broadcasts."""
        await websocket.accept(subprotocol="supalai.live")
        try:
            snapshot = await asyncio.to_thread(self._snapshot_provider)
            await websocket.send_json(self._message("snapshot", snapshot))
        except Exception:
            await websocket.close(code=1011, reason="Live snapshot unavailable")
            raise

        was_empty = not self._clients
        self._clients.add(websocket)
        if self._has_clients is not None:
            self._has_clients.set()
        if was_empty:
            self._last_fingerprint = self._fingerprint(snapshot)

    async def disconnect(self, websocket: WebSocket) -> None:
        self._clients.discard(websocket)
        if not self._clients:
            if self._has_clients is not None:
                self._has_clients.clear()
            self._last_fingerprint = None

    @staticmethod
    def _message(message_type: str, snapshot: dict[str, Any]) -> dict[str, Any]:
        return {
            "type": message_type,
            "ok": True,
            "now": snapshot.get("now"),
            "tags": snapshot.get("tags", {}),
        }

    @staticmethod
    def _fingerprint(snapshot: dict[str, Any]) -> str:
        # `now` changes on every query; tag content changes only when there is
        # a new position or an online/offline status transition.
        return json.dumps(snapshot.get("tags", {}), sort_keys=True, separators=(",", ":"), default=str)

    async def _broadcast(self, snapshot: dict[str, Any]) -> None:
        clients = list(self._clients)
        if not clients:
            return
        results = await asyncio.gather(
            *(client.send_json(self._message("tags", snapshot)) for client in clients),
            return_exceptions=True,
        )
        for client, result in zip(clients, results, strict=True):
            if isinstance(result, Exception):
                logger.debug("dropping disconnected live client: %s", result)
                await self.disconnect(client)

    async def _run(self) -> None:
        try:
            while True:
                has_clients = self._has_clients
                if has_clients is None:
                    return
                await has_clients.wait()
                started = asyncio.get_running_loop().time()
                try:
                    snapshot = await asyncio.to_thread(self._snapshot_provider)
                    fingerprint = self._fingerprint(snapshot)
                    if fingerprint != self._last_fingerprint:
                        self._last_fingerprint = fingerprint
                        await self._broadcast(snapshot)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("live WebSocket snapshot failed")

                elapsed = asyncio.get_running_loop().time() - started
                await asyncio.sleep(max(0, self._interval - elapsed))
        except asyncio.CancelledError:
            pass
