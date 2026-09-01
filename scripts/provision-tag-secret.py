"""Provision the hardware-ingest HMAC secret over USB without logging it."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import serial


def read_env_value(path: Path, key: str) -> str:
    for raw_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == key:
            return value.strip().strip("'\"")
    return ""


def normal_reset(port: serial.Serial) -> None:
    # ESP32 auto-reset: keep GPIO0 high, pulse EN low, then release EN.
    port.dtr = False
    port.rts = True
    time.sleep(0.15)
    port.rts = False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()

    secret = read_env_value(args.env_file, "HARDWARE_INGEST_SECRET")
    if len(secret) < 32:
        print("[provision] HARDWARE_INGEST_SECRET is missing or too short")
        return 2

    monitor = serial.Serial()
    monitor.port = args.port
    monitor.baudrate = 115200
    monitor.timeout = 0.2
    monitor.dtr = False
    monitor.rts = False
    monitor.open()

    try:
        monitor.reset_input_buffer()
        normal_reset(monitor)
        print(f"[provision] reset {args.port}; waiting for Tag firmware")

        deadline = time.monotonic() + 28
        sent = False
        stored = False
        tag_started = False
        wifi_connected = False
        pending = bytearray()

        while time.monotonic() < deadline:
            chunk = monitor.read(monitor.in_waiting or 1)
            if not chunk:
                continue
            pending.extend(chunk)
            while b"\n" in pending:
                raw_line, _, remainder = pending.partition(b"\n")
                pending = bytearray(remainder)
                # Boot ROM output can contain partial UTF-8 bytes when the
                # monitor opens mid-line; discard only those damaged bytes.
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line:
                    continue
                if secret in line or "UWB_SECRET:" in line:
                    line = "[provision] redacted secret-bearing serial line"
                print(line)

                if "HMAC secret missing" in line and not sent:
                    monitor.write(("UWB_SECRET:" + secret + "\n").encode("utf-8"))
                    monitor.flush()
                    sent = True
                    print("[provision] secret sent (value hidden)")
                if "HMAC secret stored; restarting" in line:
                    stored = True
                if line.startswith("[tag] TAG01"):
                    tag_started = True
                if line.startswith("[wifi] connected ip="):
                    wifi_connected = True
                    break
            if wifi_connected:
                break

        if not sent and not tag_started:
            print("[provision] Tag provisioning prompt was not detected")
            return 3
        if sent and not stored:
            print("[provision] board did not confirm that the secret was stored")
            return 4
        if not tag_started:
            print("[provision] secret stored, but Tag restart was not observed")
            return 5
        if not wifi_connected:
            print("[provision] Tag started; Wi-Fi connection was not confirmed yet")
            return 6

        print("[provision] Tag secret stored and Wi-Fi connected")
        return 0
    finally:
        monitor.close()
        secret = ""


if __name__ == "__main__":
    raise SystemExit(main())
