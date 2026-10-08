"""Opaque cursor pagination: ?cursor=&limit= (cursor = base64 of 'iso_timestamp|id')."""
from __future__ import annotations

import base64
from datetime import datetime

DEFAULT_LIMIT, MAX_LIMIT = 25, 100


def clamp(limit: int | None) -> int:
    return max(1, min(limit or DEFAULT_LIMIT, MAX_LIMIT))


def encode(ts: datetime, row_id: object) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{row_id}".encode()).decode()


def decode(cursor: str | None) -> tuple[datetime, str] | None:
    if not cursor:
        return None
    try:
        ts, _, rid = base64.urlsafe_b64decode(cursor.encode()).decode().partition("|")
        return datetime.fromisoformat(ts), rid
    except (ValueError, UnicodeDecodeError):
        return None
