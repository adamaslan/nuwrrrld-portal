"""SQLite response cache with a per-entry TTL."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path
from typing import Any

DEFAULT_CACHE_PATH = Path(__file__).resolve().parents[2] / ".cache" / "responses.sqlite"


class ResponseCache:
    def __init__(self, path: Path | str = DEFAULT_CACHE_PATH):
        self._path = str(path)
        if self._path != ":memory:":
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self._path)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires REAL NOT NULL)"
        )

    @staticmethod
    def _key(path: str, params: dict[str, Any]) -> str:
        return path + "?" + json.dumps(params, sort_keys=True, default=str)

    def get(self, path: str, params: dict[str, Any]) -> Any | None:
        row = self._db.execute(
            "SELECT v, expires FROM cache WHERE k = ?", (self._key(path, params),)
        ).fetchone()
        if row is None or row[1] < time.time():
            return None
        return json.loads(row[0])

    def put(self, path: str, params: dict[str, Any], value: Any, ttl: float) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO cache (k, v, expires) VALUES (?, ?, ?)",
            (self._key(path, params), json.dumps(value), time.time() + ttl),
        )
        self._db.commit()
