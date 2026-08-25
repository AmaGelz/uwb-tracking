"""Unit tests for the WebSocket fan-out loop; no database is required."""

import asyncio
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend" / "backend"))

from live_hub import LiveHub, session_token_from_protocol_header  # noqa: E402


class FakeWebSocket:
    def __init__(self, fail_after: int | None = None) -> None:
        self.accepted_protocol = None
        self.messages = []
        self.closed = None
        self.fail_after = fail_after

    async def accept(self, subprotocol=None) -> None:
        self.accepted_protocol = subprotocol

    async def send_json(self, message) -> None:
        if self.fail_after is not None and len(self.messages) >= self.fail_after:
            raise RuntimeError("client disconnected")
        self.messages.append(message)

    async def close(self, code=1000, reason="") -> None:
        self.closed = (code, reason)


def test_session_token_uses_expected_websocket_protocols():
    assert session_token_from_protocol_header("supalai.live, session.existing-token") == "existing-token"
    assert session_token_from_protocol_header("session.existing-token") is None
    assert session_token_from_protocol_header("supalai.live") is None


def test_snapshot_change_detection_and_multiple_clients():
    async def scenario():
        state = {"ok": True, "now": 1, "tags": {"T1": {"x": 1, "y": 2}}}
        hub = LiveHub(lambda: state, interval=0.01)
        first, second = FakeWebSocket(), FakeWebSocket()
        hub.start()
        await hub.connect(first)
        await hub.connect(second)
        await asyncio.sleep(0.04)

        assert first.accepted_protocol == "supalai.live"
        assert second.accepted_protocol == "supalai.live"
        assert [message["type"] for message in first.messages] == ["snapshot"]
        assert [message["type"] for message in second.messages] == ["snapshot"]

        state["now"] = 2  # changing only `now` must not broadcast
        await asyncio.sleep(0.03)
        assert len(first.messages) == 1

        state["tags"] = {"T1": {"x": 3, "y": 2}}
        await asyncio.sleep(0.04)
        assert first.messages[-1]["type"] == "tags"
        assert second.messages[-1]["tags"]["T1"]["x"] == 3
        assert len(first.messages) == len(second.messages) == 2
        await hub.stop()

    asyncio.run(scenario())


def test_failed_client_is_removed():
    async def scenario():
        state = {"now": 1, "tags": {"T1": {"x": 1}}}
        hub = LiveHub(lambda: state, interval=0.01)
        client = FakeWebSocket(fail_after=1)
        hub.start()
        await hub.connect(client)
        state["tags"] = {"T1": {"x": 2}}
        await asyncio.sleep(0.04)
        assert hub.client_count == 0
        await hub.stop()

    asyncio.run(scenario())


def test_shutdown_cancels_task_and_closes_clients():
    async def scenario():
        hub = LiveHub(lambda: {"now": 1, "tags": {}}, interval=0.01)
        client = FakeWebSocket()
        hub.start()
        await hub.connect(client)
        await hub.stop()
        assert hub.client_count == 0
        assert client.closed == (1012, "Server shutting down")

        restarted_client = FakeWebSocket()
        hub.start()
        await hub.connect(restarted_client)
        await hub.stop()
        assert restarted_client.closed == (1012, "Server shutting down")

    asyncio.run(scenario())
