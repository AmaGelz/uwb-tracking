"""Bridge the Makerfabs firmware already installed on a tag into FastAPI.

The legacy firmware exposes a TCP server and emits JSON objects shaped like
``{"tag_id":"tag0","links":[{"A":"1782","R":"2.34"}]}``.  This
process connects to that server, translates the ranges to the authenticated
hardware-ingest contract, and leaves positioning/database writes to FastAPI.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Iterable

from .config import settings


DEFAULT_TAG_HOST = "192.168.1.200"
DEFAULT_TAG_PORT = 8888
DEFAULT_API_URL = "http://127.0.0.1:8000/api/hardware/ingest"
DEFAULT_DEVICE_ID = "SUPALAI-TAG-GW-01"
DEFAULT_TAG_ID = "TAG01"


class JsonObjectStream:
    """Incrementally decode adjacent or newline-delimited JSON objects."""

    def __init__(self, max_buffer: int = 64 * 1024) -> None:
        self.buffer = ""
        self.max_buffer = max_buffer
        self.decoder = json.JSONDecoder()

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        self.buffer += chunk.decode("utf-8", errors="replace")
        objects: list[dict[str, Any]] = []

        while True:
            self.buffer = self.buffer.lstrip()
            if not self.buffer:
                break
            try:
                value, end = self.decoder.raw_decode(self.buffer)
            except json.JSONDecodeError:
                if len(self.buffer) > self.max_buffer:
                    start = self.buffer.rfind("{")
                    self.buffer = self.buffer[start:] if start >= 0 else ""
                break
            self.buffer = self.buffer[end:]
            if isinstance(value, dict):
                objects.append(value)

        return objects


@dataclass(frozen=True)
class BridgeConfig:
    tag_host: str
    tag_port: int
    api_url: str
    device_id: str
    tag_id: str
    connect_timeout: float
    api_timeout: float
    reconnect_seconds: float
    once: bool


def translate_frame(
    frame: dict[str, Any],
    *,
    tag_id: str | None = None,
) -> dict[str, Any] | None:
    """Translate Makerfabs ``A``/``R`` links into the ingest API schema."""
    links = frame.get("links")
    if not isinstance(links, list):
        return None

    ranges: list[dict[str, Any]] = []
    seen: set[str] = set()
    for link in links:
        if not isinstance(link, dict):
            continue
        address = str(link.get("A") or link.get("anchor_id") or "").strip()
        try:
            distance = float(link.get("R", link.get("distance_m")))
        except (TypeError, ValueError):
            continue
        if not address or address in seen or not math.isfinite(distance) or distance <= 0:
            continue
        seen.add(address)
        ranges.append({"anchor_id": address, "distance_m": distance})

    resolved_tag_id = str(tag_id or frame.get("tag_id") or "").strip()
    if not resolved_tag_id:
        return None
    return {"tag_id": resolved_tag_id, "ranges": ranges}


def sign_payload(device_id: str, timestamp: str, body: bytes, secret: str) -> str:
    signed = device_id.encode() + b"." + timestamp.encode() + b"." + body
    return hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


def post_ranges(config: BridgeConfig, translated: dict[str, Any], sequence: int) -> dict[str, Any]:
    timestamp = str(int(time.time()))
    payload = {
        "message_id": f"{config.device_id}-legacy-{time.time_ns()}-{sequence}",
        **translated,
    }
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        config.api_url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-uwb-device-id": config.device_id,
            "x-uwb-timestamp": timestamp,
            "x-uwb-signature": sign_payload(
                config.device_id,
                timestamp,
                body,
                settings.hardware_ingest_secret,
            ),
        },
    )
    with urllib.request.urlopen(request, timeout=config.api_timeout) as response:
        response_body = response.read().decode("utf-8")
    decoded = json.loads(response_body) if response_body else {"ok": True}
    return decoded if isinstance(decoded, dict) else {"ok": True, "result": decoded}


def receive_frames(connection: socket.socket) -> Iterable[dict[str, Any]]:
    stream = JsonObjectStream()
    while True:
        chunk = connection.recv(4096)
        if not chunk:
            return
        yield from stream.feed(chunk)


def run_bridge(config: BridgeConfig) -> int:
    if len(settings.hardware_ingest_secret) < 32:
        raise RuntimeError("HARDWARE_INGEST_SECRET must contain at least 32 characters")

    sequence = 0
    backoff = config.reconnect_seconds
    while True:
        try:
            print(f"Connecting to existing tag firmware at {config.tag_host}:{config.tag_port}")
            with socket.create_connection(
                (config.tag_host, config.tag_port),
                timeout=config.connect_timeout,
            ) as connection:
                connection.settimeout(None)
                print("Connected; waiting for Makerfabs ranging frames")
                backoff = config.reconnect_seconds
                for frame in receive_frames(connection):
                    translated = translate_frame(frame, tag_id=config.tag_id)
                    if translated is None:
                        print("Skipped an invalid legacy frame")
                        continue
                    range_count = len(translated["ranges"])
                    if range_count < 3:
                        print(f"Waiting for at least 3 anchors; received {range_count}")
                        continue
                    sequence += 1
                    result = post_ranges(config, translated, sequence)
                    print(
                        "Forwarded tag=%s ranges=%d result=%s"
                        % (translated["tag_id"], range_count, result.get("ok", True))
                    )
                    if config.once:
                        return 0
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            print(f"FastAPI rejected the frame: HTTP {exc.code} {detail}")
        except (ConnectionError, OSError, TimeoutError, urllib.error.URLError) as exc:
            print(f"Bridge connection failed: {exc}")

        if config.once:
            return 1
        print(f"Reconnecting in {backoff:.1f} seconds")
        time.sleep(backoff)
        backoff = min(backoff * 2, 30.0)


def parse_args(argv: list[str] | None = None) -> BridgeConfig:
    parser = argparse.ArgumentParser(
        description="Forward JSON ranges from existing Makerfabs tag firmware to FastAPI."
    )
    parser.add_argument("--tag-host", default=os.getenv("UWB_LEGACY_TAG_HOST", DEFAULT_TAG_HOST))
    parser.add_argument(
        "--tag-port",
        type=int,
        default=int(os.getenv("UWB_LEGACY_TAG_PORT", str(DEFAULT_TAG_PORT))),
    )
    parser.add_argument("--api-url", default=os.getenv("UWB_LEGACY_API_URL", DEFAULT_API_URL))
    parser.add_argument("--device-id", default=os.getenv("UWB_LEGACY_DEVICE_ID", DEFAULT_DEVICE_ID))
    parser.add_argument("--tag-id", default=os.getenv("UWB_LEGACY_TAG_ID", DEFAULT_TAG_ID))
    parser.add_argument("--connect-timeout", type=float, default=5.0)
    parser.add_argument("--api-timeout", type=float, default=5.0)
    parser.add_argument("--reconnect-seconds", type=float, default=2.0)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    return BridgeConfig(
        tag_host=args.tag_host,
        tag_port=args.tag_port,
        api_url=args.api_url,
        device_id=args.device_id,
        tag_id=args.tag_id,
        connect_timeout=args.connect_timeout,
        api_timeout=args.api_timeout,
        reconnect_seconds=args.reconnect_seconds,
        once=args.once,
    )


def main(argv: list[str] | None = None) -> int:
    try:
        return run_bridge(parse_args(argv))
    except KeyboardInterrupt:
        print("Bridge stopped")
        return 130
    except RuntimeError as exc:
        print(f"Bridge configuration error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
