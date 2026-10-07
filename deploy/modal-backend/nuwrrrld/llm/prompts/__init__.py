"""Versioned prompt loader: prompts/{feature}/v{N}.md; the version is stored with every output."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_ROOT = Path(__file__).parent
LATEST = {"digest": 1, "chat": 1, "health": 1, "holdfold": 1, "council": 1, "followed": 1}


@lru_cache(maxsize=None)
def load(feature: str, version: int | None = None) -> tuple[str, str]:
    """Return (prompt_text, prompt_version_label)."""
    v = version or LATEST[feature]
    return (_ROOT / feature / f"v{v}.md").read_text(), f"{feature}.v{v}"
