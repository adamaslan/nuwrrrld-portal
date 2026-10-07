"""Provider-neutral LLM client with budgets, circuit breaker, usage logging and one validated retry.

Chat streaming uses `astream` (async). Everything else uses the sync `complete`.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx

from nuwrrrld.calendar import ET, today_et

log = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
HTTP_TIMEOUT_SECONDS = 120.0
EST_CHARS_PER_TOKEN = 4

BUDGET_UPSERT_SQL = """
INSERT INTO user_llm_budgets (user_id, day_et, tokens_used, requests) VALUES (%s, %s, %s, 1)
ON CONFLICT (user_id, day_et) DO UPDATE
  SET tokens_used = user_llm_budgets.tokens_used + EXCLUDED.tokens_used,
      requests    = user_llm_budgets.requests + 1
RETURNING tokens_used, requests"""


class LLMBudgetExceeded(Exception):
    def __init__(self, reset_at: str):
        super().__init__("budget_exceeded")
        self.reset_at = reset_at


class LLMBreakerOpen(Exception):
    pass


@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cached_tokens: int
    latency_ms: int
    est_cost_usd: float | None
    parsed: Any = None


def estimate_tokens(messages: list[dict]) -> int:
    return sum(len(str(m.get("content", ""))) for m in messages) // EST_CHARS_PER_TOKEN + 1


def midnight_et_iso() -> str:
    import datetime as dt
    tomorrow = today_et() + dt.timedelta(days=1)
    return dt.datetime.combine(tomorrow, dt.time(0), tzinfo=ET).isoformat()


def cost_usd(model: str, in_tok: int, out_tok: int, rates: dict[str, tuple[float, float]]) -> float | None:
    """Rates are USD per 1M tokens from a table YOU maintain (LLM_RATE_TABLE_JSON)."""
    if model not in rates:
        return None
    pin, pout = rates[model]
    return round(in_tok / 1e6 * pin + out_tok / 1e6 * pout, 6)


def load_rates() -> dict[str, tuple[float, float]]:
    raw = os.environ.get("LLM_RATE_TABLE_JSON", "{}")
    try:
        return {k: (float(v[0]), float(v[1])) for k, v in json.loads(raw).items()}
    except (ValueError, TypeError, IndexError):
        log.warning("LLM_RATE_TABLE_JSON is malformed; cost estimates disabled")
        return {}


class LLMClient:
    def __init__(self, conn_factory: Callable[[], Any], *, breaker_open: Callable[[], bool] = lambda: False,
                 http: httpx.Client | None = None, model_fast: str | None = None, model_smart: str | None = None,
                 provider: str | None = None, per_user_daily_tokens: int | None = None):
        self._conn_factory = conn_factory
        self._breaker_open = breaker_open
        self._http = http or httpx.Client(timeout=HTTP_TIMEOUT_SECONDS)
        self._models = {"fast": model_fast or os.environ.get("LLM_MODEL_FAST", ""),
                        "smart": model_smart or os.environ.get("LLM_MODEL_SMART", "")}
        self._provider = provider or os.environ.get("LLM_PROVIDER", "openrouter")
        self._user_cap = per_user_daily_tokens or int(os.environ.get("USER_DAILY_TOKEN_BUDGET", "60000"))
        self._rates = load_rates()

    # -- budget -----------------------------------------------------------------
    def _check_and_reserve(self, user_id: str | None, est_tokens: int) -> None:
        if self._breaker_open():
            raise LLMBreakerOpen()
        if user_id is None:
            return
        with self._conn_factory() as conn:
            row = conn.execute(BUDGET_UPSERT_SQL, (user_id, today_et(), est_tokens)).fetchone()
        if row["tokens_used"] > self._user_cap:
            raise LLMBudgetExceeded(midnight_et_iso())

    def _reconcile(self, user_id: str | None, est: int, actual: int) -> None:
        if user_id is None or actual == est:
            return
        with self._conn_factory() as conn:
            conn.execute("UPDATE user_llm_budgets SET tokens_used = GREATEST(0, tokens_used + %s) "
                         "WHERE user_id=%s AND day_et=%s", (actual - est, user_id, today_et()))

    def _log_usage(self, feature: str, ref_id: str | None, user_id: str | None, res: LLMResult, ok: bool) -> None:
        try:
            with self._conn_factory() as conn:
                conn.execute(
                    """INSERT INTO llm_usage (user_id, feature, ref_id, provider, model, input_tokens, output_tokens,
                                              cached_tokens, est_cost_usd, latency_ms, ok)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (user_id, feature, ref_id, self._provider, res.model, res.input_tokens, res.output_tokens,
                     res.cached_tokens, res.est_cost_usd, res.latency_ms, ok))
        except Exception:  # usage logging must never break a feature
            log.exception("llm_usage insert failed")

    # -- provider calls -----------------------------------------------------------
    def _call(self, model: str, messages: list[dict], max_out: int, json_mode: bool) -> tuple[str, int, int, int]:
        if self._provider == "anthropic":
            system = "\n".join(m["content"] for m in messages if m["role"] == "system")
            body = {"model": model, "max_tokens": max_out, "temperature": 0.2,
                    "messages": [m for m in messages if m["role"] != "system"]}
            if system:
                body["system"] = system
            r = self._http.post(ANTHROPIC_URL, json=body, headers={
                "x-api-key": os.environ["LLM_API_KEY"], "anthropic-version": "2023-06-01"})
            r.raise_for_status()
            d = r.json()
            u = d.get("usage", {})
            return ("".join(b.get("text", "") for b in d["content"]), u.get("input_tokens", 0),
                    u.get("output_tokens", 0), u.get("cache_read_input_tokens", 0))
        body = {"model": model, "messages": messages, "max_tokens": max_out, "temperature": 0.2}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        r = self._http.post(OPENROUTER_URL, json=body, headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"})
        r.raise_for_status()
        d = r.json()
        u = d.get("usage", {})
        return (d["choices"][0]["message"]["content"], u.get("prompt_tokens", 0), u.get("completion_tokens", 0),
                (u.get("prompt_tokens_details") or {}).get("cached_tokens", 0))

    def complete(self, feature: str, messages: list[dict], *, model_tier: str = "fast", max_output_tokens: int = 400,
                 schema: Callable[[Any], Any] | None = None, user_id: str | None = None, ref_id: str | None = None,
                 validator: Callable[[str], list[str]] | None = None) -> LLMResult:
        """Budget -> call -> (parse via `schema`) -> (validate via `validator`, one retry with errors listed)."""
        model = self._models[model_tier]
        est = estimate_tokens(messages) + max_output_tokens
        self._check_and_reserve(user_id, est)
        attempt_messages, last_errors = list(messages), []
        for attempt in range(2):
            started = time.perf_counter()
            text, tin, tout, cached = self._call(model, attempt_messages, max_output_tokens, schema is not None)
            latency = int((time.perf_counter() - started) * 1000)
            res = LLMResult(text, model, tin, tout, cached, latency, cost_usd(model, tin, tout, self._rates))
            problems: list[str] = []
            parsed = None
            if schema is not None:
                try:
                    parsed = schema(json.loads(text))
                except (ValueError, TypeError, KeyError) as exc:
                    problems.append(f"output did not match the schema: {exc}")
            if not problems and validator is not None:
                problems = validator(text)
            self._log_usage(feature, ref_id, user_id, res, ok=not problems)
            self._reconcile(user_id, est, tin + tout)
            if not problems:
                return LLMResult(**{**res.__dict__, "parsed": parsed})
            last_errors = problems
            attempt_messages = messages + [{"role": "user", "content": "Fix these problems and answer again: " + "; ".join(problems)}]
        raise ValueError("; ".join(last_errors))

    async def astream(self, messages: list[dict], *, model_tier: str = "smart", max_output_tokens: int = 700,
                      ) -> AsyncIterator[str]:
        """Yield text deltas from an OpenAI-compatible streaming endpoint (chat)."""
        if self._breaker_open():
            raise LLMBreakerOpen()
        body = {"model": self._models[model_tier], "messages": messages, "max_tokens": max_output_tokens,
                "temperature": 0.3, "stream": True}
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
            async with client.stream("POST", OPENROUTER_URL, json=body,
                                     headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"}) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: ") or line.endswith("[DONE]"):
                        continue
                    try:
                        delta = json.loads(line[6:])["choices"][0]["delta"].get("content")
                    except (ValueError, KeyError, IndexError):
                        continue
                    if delta:
                        yield delta
