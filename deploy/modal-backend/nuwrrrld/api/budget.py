"""Per-user daily LLM token budget (atomic upsert) for the async API paths."""
from __future__ import annotations

from fastapi import HTTPException

from nuwrrrld import db
from nuwrrrld.calendar import today_et
from nuwrrrld.config import settings
from nuwrrrld.llm.client import midnight_et_iso

UPSERT = """INSERT INTO user_llm_budgets (user_id, day_et, tokens_used, requests) VALUES ($1,$2,$3,1)
            ON CONFLICT (user_id, day_et) DO UPDATE SET tokens_used = user_llm_budgets.tokens_used + EXCLUDED.tokens_used,
              requests = user_llm_budgets.requests + 1 RETURNING tokens_used"""


async def reserve(user_id, est_tokens: int) -> None:
    used = await db.pool().fetchval(UPSERT, user_id, today_et(), est_tokens)
    if used > settings().user_daily_token_budget:
        raise HTTPException(429, detail={"code": "budget_exceeded", "reset_at": midnight_et_iso()})


async def reconcile(user_id, est: int, actual: int) -> None:
    if actual != est:
        await db.pool().execute("UPDATE user_llm_budgets SET tokens_used = GREATEST(0, tokens_used + $3) WHERE user_id=$1 AND day_et=$2",
                                user_id, today_et(), actual - est)


async def breaker_open(hot_cache) -> bool:
    try:
        return bool(hot_cache.get("llm_breaker"))
    except Exception:
        return False
