"""Spawn deployed Modal functions from the API and read the LLM breaker flag."""
from __future__ import annotations

import logging
import os

from fastapi import HTTPException

log = logging.getLogger(__name__)
APP_NAME = os.environ.get("MODAL_APP_NAME", "nuwrrrld")
HOT_CACHE_NAME = "nuwrrrld-hot-cache"


async def spawn(fn_name: str, *args, **kwargs) -> str:
    import modal
    try:
        fn = modal.Function.from_name(APP_NAME, fn_name)
        call = await fn.spawn.aio(*args, **kwargs)
        return call.object_id
    except Exception as exc:  # modal raises a variety of RPC/lookup errors
        log.exception("spawn failed fn=%s", fn_name)
        raise HTTPException(503, detail={"code": "spawn_failed", "detail": "Background worker unavailable"}) from exc


def llm_breaker_open() -> bool:
    try:
        import modal
        return bool(modal.Dict.from_name(HOT_CACHE_NAME, create_if_missing=True).get("llm_breaker"))
    except Exception:
        return False


def require_llm() -> None:
    if llm_breaker_open():
        raise HTTPException(503, detail={"code": "llm_paused", "detail": "AI features are paused for today; deterministic data remains available."})
