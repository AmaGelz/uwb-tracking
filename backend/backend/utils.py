from __future__ import annotations

from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_epoch(dt: datetime | None) -> float | None:
    """Convert a (tz-aware) Postgres timestamptz value to epoch seconds.

    The frontend works entirely in epoch seconds (`new Date(ts * 1000)`),
    so every timestamp leaving the API through the JSON layer is
    converted here rather than left as an ISO string.
    """
    if dt is None:
        return None
    return dt.timestamp()
