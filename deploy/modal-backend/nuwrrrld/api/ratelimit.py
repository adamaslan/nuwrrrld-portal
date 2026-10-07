"""Fixed-window rate limiting on a Postgres counter table (migration 0002)."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request

from nuwrrrld import db

LIMITS: dict[str, tuple[int, int]] = {      # action -> (max hits, window seconds)
    "chat": (30, 60), "health_check": (3, 3600), "council_convene": (10, 3600), "checkout": (10, 3600),
    "referral_click": (30, 60), "referral_attribute": (10, 3600), "import": (10, 3600),
}


def ip_hash(request: Request) -> str:
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()
    return hashlib.sha256(ip.encode()).hexdigest()[:24]


async def hit(action: str, subject: str) -> None:
    limit, window = LIMITS[action]
    now = datetime.now(timezone.utc)
    start = datetime.fromtimestamp(int(now.timestamp()) // window * window, timezone.utc)
    n = await db.pool().fetchval(
        """INSERT INTO rate_limits (bucket, window_start) VALUES ($1,$2)
           ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1 RETURNING hits""",
        f"{action}:{subject}", start)
    if n > limit:
        retry = int((start + timedelta(seconds=window) - now).total_seconds()) + 1
        raise HTTPException(429, detail={"code": "rate_limited", "retry_after": retry})
