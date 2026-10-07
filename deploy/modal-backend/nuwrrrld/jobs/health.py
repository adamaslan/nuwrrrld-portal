"""Portfolio Intel health check (Section 9.5): deterministic metrics -> rule findings -> validated LLM summary."""
from __future__ import annotations

import json
import logging

import httpx

from nuwrrrld import dynamo
from nuwrrrld.calendar import today_et
from nuwrrrld.core import portfolio_metrics
from nuwrrrld.llm import prompts, validate
from nuwrrrld.llm.client import LLMBreakerOpen, LLMBudgetExceeded, LLMClient

log = logging.getLogger(__name__)


def _positions(conn, user_id: str) -> list[dict]:
    return conn.execute(
        """SELECT h.ticker, h.quantity::float AS quantity, h.account_label, i.sector,
                  (SELECT adj_close::float FROM price_bars b WHERE b.ticker=h.ticker ORDER BY bar_date DESC LIMIT 1) AS close,
                  (SELECT value::float FROM factor_exposures f WHERE f.ticker=h.ticker AND f.factor='beta_spy_252'
                     ORDER BY as_of_date DESC LIMIT 1) AS beta,
                  (SELECT value::float FROM factor_exposures f WHERE f.ticker=h.ticker AND f.factor='vol_63'
                     ORDER BY as_of_date DESC LIMIT 1) AS vol_63,
                  (SELECT direction FROM signals s WHERE s.ticker=h.ticker ORDER BY as_of_date DESC LIMIT 1) AS signal_direction,
                  (SELECT verdict FROM hold_fold_verdicts v WHERE v.ticker=h.ticker AND v.scope='global'
                     ORDER BY as_of_date DESC LIMIT 1) AS verdict
             FROM holdings h JOIN instruments i ON i.ticker=h.ticker WHERE h.user_id=%s""", (user_id,)).fetchall()


def create_check(conn, user_id: str, trigger: str) -> tuple[str, bool]:
    """(check_id, created). Skips recompute when the holdings hash is unchanged for the data date."""
    positions = _positions(conn, user_id)
    hsh = portfolio_metrics.holdings_hash(positions)
    as_of = conn.execute("SELECT max(bar_date) AS d FROM price_bars").fetchone()["d"] or today_et()
    row = conn.execute(
        """INSERT INTO portfolio_health_checks (user_id, as_of_date, trigger, status, holdings_hash)
           VALUES (%s,%s,%s,'queued',%s) ON CONFLICT (user_id, as_of_date, holdings_hash) DO NOTHING RETURNING id""",
        (user_id, as_of, trigger, hsh)).fetchone()
    if row:
        return str(row["id"]), True
    existing = conn.execute("SELECT id FROM portfolio_health_checks WHERE user_id=%s AND as_of_date=%s AND holdings_hash=%s",
                            (user_id, as_of, hsh)).fetchone()
    return str(existing["id"]), False


def run_health_check(conn, llm: LLMClient | None, check_id: str) -> str:
    chk = conn.execute("UPDATE portfolio_health_checks SET status='running' WHERE id=%s AND status IN ('queued','failed') "
                       "RETURNING *", (check_id,)).fetchone()
    if chk is None:
        return "skipped"
    try:
        metrics = portfolio_metrics.compute_metrics(_positions(conn, str(chk["user_id"])))
        found = portfolio_metrics.findings(metrics)
        payload = {"metrics": metrics, "findings": found}
        summary = validate.directive_filter(
            "Portfolio check: " + ("; ".join(f["message"] for f in found) if found else "no rule-based findings."))
        model, version = None, None
        if llm is not None and metrics.get("weights"):
            system, version = prompts.load("health")
            try:
                res = llm.complete("health_check", [{"role": "system", "content": system},
                                                    {"role": "user", "content": json.dumps(payload, default=str)}],
                                   model_tier="smart", max_output_tokens=450, user_id=str(chk["user_id"]), ref_id=check_id,
                                   validator=lambda t: [f"number {n} not in the input" for n in validate.unmatched_numbers(t, payload)])
                summary, model = validate.directive_filter(res.text), res.model
            except (ValueError, LLMBreakerOpen, LLMBudgetExceeded, httpx.HTTPError) as exc:
                log.warning("health summary used template: %s", exc)
        row = conn.execute(
            """UPDATE portfolio_health_checks SET status='done', metrics=%s, findings=%s, summary_md=%s, model=%s,
                      prompt_version=%s, finished_at=now() WHERE id=%s RETURNING *""",
            (json.dumps(metrics), json.dumps(found), summary, model, version, check_id)).fetchone()
        dynamo.mirror_rows("portfolio_health", [{**row, "metrics": metrics, "findings": found}])
        return "done"
    except Exception as exc:
        conn.execute("UPDATE portfolio_health_checks SET status='failed', error=%s, finished_at=now() WHERE id=%s",
                     (repr(exc)[:2000], check_id))
        raise


def weekly_check_ids(conn) -> list[str]:
    """Create (or reuse) a check for every active user with holdings; returns ids that need running."""
    users = conn.execute("SELECT DISTINCT h.user_id FROM holdings h JOIN user_access a ON a.user_id=h.user_id "
                         "WHERE a.access_until > now()").fetchall()
    ids = []
    for u in users:
        cid, created = create_check(conn, str(u["user_id"]), "scheduled")
        if created:
            ids.append(cid)
    return ids
