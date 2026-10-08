"""Named ticker lists saved from uploads. One JSON file per list, on this machine only.

Name rules mirror the portal's (lib/watchlist-import.ts: normalizeListName) so a list
named here is also a valid name there.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from nwf_lab.errors import LabError
from nwf_lab.symbols import canonical

DEFAULT_LISTS_DIR = Path(__file__).resolve().parents[1] / "saved_lists"
MAX_NAME_LENGTH = 40
MAX_SAVED_LISTS = 25
MAX_TICKERS_PER_LIST = 500
_NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _\-.()&']*$")
_TICKER_PATTERN = re.compile(r"^[A-Z][A-Z.\-]{0,9}$")


@dataclass(frozen=True)
class SavedList:
    name: str
    tickers: tuple[str, ...]
    saved_at: str


def normalize_name(raw: str) -> str:
    """Trim and collapse spaces; raise LabError unless the result is a plain, bounded name."""
    if not isinstance(raw, str) or re.search(r"[\r\n\t]", raw):
        raise LabError("List name must be single-line text.")
    name = re.sub(r" {2,}", " ", raw.strip())
    if not name or len(name) > MAX_NAME_LENGTH or not _NAME_PATTERN.match(name):
        raise LabError(
            f"List name must be 1-{MAX_NAME_LENGTH} characters: letters, numbers, spaces and _ - . ( ) & '.")
    return name


def clean_tickers(raw: list[str]) -> tuple[str, ...]:
    """Upper-case, dedupe (order kept), drop anything that is not ticker-shaped."""
    seen: dict[str, None] = {}
    for value in raw:
        symbol = canonical(str(value))
        if _TICKER_PATTERN.match(symbol):
            seen.setdefault(symbol)
    return tuple(seen)[:MAX_TICKERS_PER_LIST]


class SavedListStore:
    def __init__(self, directory: Path | None = None) -> None:
        env_dir = os.getenv("NWF_LAB_LISTS_DIR")
        self._dir = directory or (Path(env_dir) if env_dir else DEFAULT_LISTS_DIR)

    def _path(self, name: str) -> Path:
        digest = hashlib.sha1(name.lower().encode("utf-8")).hexdigest()[:16]
        return self._dir / f"{digest}.json"

    def save(self, raw_name: str, tickers: list[str]) -> SavedList:
        """Save under `raw_name`; a name that already exists (any case) is overwritten."""
        name = normalize_name(raw_name)
        symbols = clean_tickers(tickers)
        if not symbols:
            raise LabError("No valid tickers to save.")
        path = self._path(name)
        if not path.exists() and len(self.names()) >= MAX_SAVED_LISTS:
            raise LabError(f"At most {MAX_SAVED_LISTS} saved lists; delete one first.")
        saved = SavedList(name, symbols, datetime.now(UTC).isoformat(timespec="seconds"))
        self._dir.mkdir(parents=True, exist_ok=True)
        payload = json.dumps({"name": saved.name, "tickers": list(symbols), "saved_at": saved.saved_at})
        with tempfile.NamedTemporaryFile("w", dir=self._dir, suffix=".tmp", delete=False) as tmp:
            tmp.write(payload)
        os.replace(tmp.name, path)
        return saved

    def load(self, name: str) -> SavedList | None:
        path = self._path(normalize_name(name))
        if not path.exists():
            return None
        return self._read(path)

    def all_lists(self) -> list[SavedList]:
        """Newest first. Unreadable files are skipped rather than crashing the app."""
        if not self._dir.exists():
            return []
        lists = [item for p in self._dir.glob("*.json") if (item := self._read(p)) is not None]
        return sorted(lists, key=lambda item: item.saved_at, reverse=True)

    def names(self) -> list[str]:
        return [item.name for item in self.all_lists()]

    def delete(self, name: str) -> bool:
        path = self._path(normalize_name(name))
        if not path.exists():
            return False
        path.unlink()
        return True

    @staticmethod
    def _read(path: Path) -> SavedList | None:
        try:
            data = json.loads(path.read_text())
            return SavedList(str(data["name"]), tuple(data["tickers"]), str(data["saved_at"]))
        except (OSError, ValueError, KeyError, TypeError):
            return None
