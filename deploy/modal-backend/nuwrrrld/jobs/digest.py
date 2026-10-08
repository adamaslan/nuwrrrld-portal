"""Signal Digest explanations + publish (Section 9.1)."""
from __future__ import annotations

import json
import logging

import httpx

from nuwrrrld import dynamo
from nuwrrrld.llm import prompts, validate
from nuwrrrld.llm.client import LLMBreakerOpen, LLMBudgetExceeded, LLMClient

log = logging.getLogger(__name__)
MIN_LLM_SHARE = 0.90
MAX_EXPLANATION_TOKENS = 320


def explain_signal(conn, llm: LLMClient | None, signal_id: str) -> str:
    """Idempotent per (signal_id, prompt_version). LLM text only if the numeric validator passes, else template."""
    system, version = prompts.load("digest")
    sig = conn.execute(
        """SELECT s.*, i.name FROM signals s JOIN instruments i ON i.ticker = s.ticker WHERE s.id = %s""",
        (signal_id,)).fetchone()
    if sig is None:
        return "missing"
    if sig["explanation_md"] and sig["prompt_version"] == version:
        return sig["explanation_source"]
    payload = {"ticker": sig["ticker"], "name": sig["name"], "direction": sig["direction"],
               "strength": float(sig["strength"]), "timeframe": sig["timeframe"], "horizon_days": sig["horizon_days"],
               "fired_indicators": sig["fired_indicators"]}
    text, source, model, validated = validate.template_explanation(payload), "template", None, False
    if llm is not None:
        try:
            res = llm.complete("digest", [{"role": "system", "content": system},
                                          {"role": "user", "content": json.dumps(payload, default=str)}],
                               model_tier="fast", max_output_tokens=MAX_EXPLANATION_TOKENS, ref_id=str(sig["id"]),
                               validator=lambda t: [f"number {n} not in the input" for n in validate.unmatched_numbers(t, payload)])
            text, source, model, validated = validate.directive_filter(res.text), "llm", res.model, True
        except (ValueError, LLMBreakerOpen, LLMBudgetExceeded, httpx.HTTPError) as exc:
            log.warning("explanation fell back to template ticker=%s reason=%s", sig["ticker"], exc)
    conn.execute(
        """UPDATE signals SET explanation_md=%s, explanation_source=%s, explanation_model=%s, prompt_version=%s,
                  explanation_validated=%s WHERE id=%s""", (text, source, model, version, validated, signal_id))
    return source


def finalize_run(conn, run_id: str, results: list) -> dict:
    """results come from explain_one_signal.map(..., return_exceptions=True): failures get the template."""
    failures = [r for r in results if isinstance(r, Exception)]
    for sid in [r["id"] for r in conn.execute(
            "SELECT id FROM signals WHERE run_id=%s AND explanation_md IS NULL", (run_id,)).fetchall()]:
        explain_signal(conn, None, str(sid))
    stats = conn.execute(
        """SELECT count(*) AS n, count(*) FILTER (WHERE explanation_source='llm') AS llm FROM signals WHERE run_id=%s""",
        (run_id,)).fetchone()
    share = (stats["llm"] / stats["n"]) if stats["n"] else 0.0
    if share < MIN_LLM_SHARE:
        log.warning("only %.0f%% of explanations are LLM-validated; the rest use templates (backfill_gaps retries)", share * 100)
    conn.execute("UPDATE signal_runs SET status='explained', stats = stats || %s WHERE id=%s AND status='computed'",
                 (json.dumps({"llm_share": round(share, 3), "explain_failures": len(failures)}), run_id))
    return {"llm_share": share, "failures": len(failures)}


def publish_latest(conn) -> dict | None:
    """07:00 ET deadline: publish the newest computed/explained run that is newer than the last published one.

    At the deadline templates cover any gap, so a slow LLM never blocks the digest.
    """
    run = conn.execute(
        """SELECT * FROM signal_runs WHERE status IN ('explained','computed') AND NOT is_backfill
           AND as_of_date > COALESCE((SELECT max(as_of_date) FROM signal_runs WHERE status='published'), 'epoch')
           ORDER BY as_of_date DESC LIMIT 1""").fetchone()
    if run is None:
        return None
    finalize_run(conn, str(run["id"]), [])
    conn.execute("UPDATE signal_runs SET status='published', published_at=now() WHERE id=%s", (run["id"],))
    return digest_payload(conn, run["as_of_date"])


def digest_payload(conn, as_of) -> dict:
    rows = conn.execute(
        """SELECT s.ticker, i.name, s.direction, s.strength, s.timeframe, s.horizon_days, s.fired_indicators,
                  s.explanation_md, s.explanation_source
             FROM signals s JOIN instruments i ON i.ticker=s.ticker JOIN signal_runs r ON r.id=s.run_id
            WHERE s.as_of_date=%s AND r.status='published' ORDER BY abs(s.strength) DESC, s.ticker""", (as_of,)).fetchall()
    return {"as_of": as_of.isoformat(), "signals": [{**r, "strength": float(r["strength"])} for r in rows],
            "disclaimer": "Educational only. Not investment advice."}
