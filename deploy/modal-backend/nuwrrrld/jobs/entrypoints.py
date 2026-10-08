"""Job bodies called by the thin Modal wrappers. No Modal imports here, so everything is testable.

Each takes `run_key`/`force` so /admin/jobs/{job}/run can re-run one idempotently (force deletes the claim).
Fan-out (.map / .spawn) is injected as callables by the Modal wrapper.
"""
from __future__ import annotations

import datetime as dt
import logging
import time
from typing import Callable

from nuwrrrld import db, dynamo
from nuwrrrld.calendar import iso_week_key, today_et
from nuwrrrld.jobs import (billing_jobs, council as council_jobs, digest, followed, health, ingest, maintenance, paper,
                           signals, universe)
from nuwrrrld.jobs.runner import run_job

log = logging.getLogger(__name__)
DEPENDENCY_POLL_SECONDS = 300
DEPENDENCY_MAX_POLLS = 12


def _session_or_skip(conn, ctx_name: str, run_key: str | None, force: bool):
    cal = universe.calendar_for(conn)
    today = today_et()
    return cal, cal.session_for(today), (run_key or (cal.session_for(today) or today).isoformat())


def _wait_for(conn, ctx, job: str, run_key: str, sleep: Callable[[float], None] | None = None) -> bool:
    """In-function wait for an upstream job (Section 16.1); heartbeats so the watchdog sees a wait, not a hang."""
    sleep = sleep or time.sleep          # resolved per call so tests can patch time.sleep
    for _ in range(DEPENDENCY_MAX_POLLS):
        row = conn.execute("SELECT status FROM job_runs WHERE job_name=%s AND run_key=%s", (job, run_key)).fetchone()
        if row and row["status"] == "succeeded":
            return True
        ctx.heartbeat()
        sleep(DEPENDENCY_POLL_SECONDS)
    return False


def _guarded(job: str, body: Callable, *, run_key: str | None, force: bool, needs: str | None = None, **kw):
    conn = db.sync_connect()
    try:
        cal, session, key = _session_or_skip(conn, job, run_key, force)
        with run_job(conn, job, key, force=force) as ctx:
            if ctx is None:
                return {"status": "not_claimed"}
            if session is None and run_key is None:
                ctx.skip("market closed")
                return {"status": "skipped"}
            if needs and not _wait_for(conn, ctx, needs, key):
                raise RuntimeError(f"{needs} did not succeed for {key}")
            result = body(conn, cal, session or dt.date.fromisoformat(key), ctx, **kw)
            ctx.detail.update({k: v for k, v in (result or {}).items() if isinstance(v, (int, float, str, bool))})
            return result
    finally:
        conn.close()


def _providers():
    from nuwrrrld.providers import get_fallback, get_provider
    return get_provider(), get_fallback()


def _llm(conn_factory=db.sync_connect):
    from nuwrrrld.api.spawn import llm_breaker_open
    from nuwrrrld.llm.client import LLMClient
    return LLMClient(conn_factory, breaker_open=llm_breaker_open)


# --- market-close pipeline ----------------------------------------------------------------
def paper_fill(order_type: str, run_key: str | None = None, force: bool = False):
    job = "paper_fill_open" if order_type == "market_on_open" else "paper_fill_close"

    def body(conn, cal, session, ctx):
        provider, _ = _providers()
        return paper.fill_pending(conn, provider, order_type, session)
    return _guarded(job, body, run_key=run_key, force=force)


def ingest_eod(cache_dir: str | None, run_key: str | None = None, force: bool = False):
    conn = db.sync_connect()
    try:
        provider, fallback = _providers()
        return ingest.ingest_eod(conn, provider, fallback, cache_dir=cache_dir, force=force)
    finally:
        conn.close()


def equity_snapshots(run_key: str | None = None, force: bool = False):
    def body(conn, cal, session, ctx):
        out = paper.snapshot_and_check_stops(conn, session)
        out["open_mismatches"] = len(paper.crosscheck_opens(conn, session))
        return out
    return _guarded("equity_snapshots", body, run_key=run_key, force=force, needs="ingest_eod_bars")


def signals_pipeline(spawn_explain: Callable[[str, list[str]], None], run_key: str | None = None, force: bool = False):
    def body(conn, cal, session, ctx):
        as_of = signals.compute_for_latest_session(conn)
        if as_of is None:
            ctx.skip("holiday or data missing (watchdog alerts)")
            return {"status": "skipped"}
        run_id, ids = signals.generate(conn, as_of)
        signals.generate_hold_fold(conn, as_of)
        signals.compute_sector_rotation(conn, as_of)
        n_alerts = signals.evaluate_watchlist_alerts(conn, as_of)
        spawn_explain(run_id, ids)            # don't hold this container while LLMs run
        return {"run_id": run_id, "signals": len(ids), "alerts": n_alerts, "as_of": as_of.isoformat()}
    return _guarded("signals_pipeline", body, run_key=run_key, force=force, needs="ingest_eod_bars")


def explain_digest(map_explain: Callable[[list[str]], list], run_id: str, signal_ids: list[str]):
    conn = db.sync_connect()
    try:
        return digest.finalize_run(conn, run_id, map_explain(signal_ids))
    finally:
        conn.close()


def explain_one(signal_id: str) -> str:
    conn = db.sync_connect()
    try:
        return digest.explain_signal(conn, _llm(), signal_id)
    finally:
        conn.close()


def digest_publish(set_cache: Callable[[dict], None], run_key: str | None = None, force: bool = False):
    conn = db.sync_connect()
    try:
        with run_job(conn, "digest_publish", run_key or today_et().isoformat(), force=force) as ctx:
            if ctx is None:
                return {"status": "not_claimed"}
            payload = digest.publish_latest(conn)
            if payload is None:
                ctx.skip("nothing new to publish")
                return {"status": "skipped"}
            set_cache(payload)
            dynamo.default().cache_put(f"digest:{payload['as_of']}", payload, 7 * 86400)
            return {"status": "published", "as_of": payload["as_of"]}
    finally:
        conn.close()


def followed_score(spawn_grade: Callable[[str, str, str], None], run_key: str | None = None, force: bool = False):
    def body(conn, cal, session, ctx):
        result = followed.score_due(conn)
        for row in conn.execute("SELECT call_id, horizon FROM followed_horizon_scores h WHERE status='scored' AND NOT EXISTS "
                                "(SELECT 1 FROM followed_llm_grades g WHERE g.call_id=h.call_id AND g.grade_type='ex_post' AND g.horizon=h.horizon) "
                                "LIMIT 200").fetchall():
            spawn_grade(str(row["call_id"]), "ex_post", row["horizon"])
        return result
    return _guarded("followed_score", body, run_key=run_key, force=force, needs="ingest_eod_bars")


def followed_freeze(spawn_grade: Callable[[str, str, str], None], run_key: str | None = None, force: bool = False):
    conn = db.sync_connect()
    try:
        month = today_et().strftime("%Y-%m")
        with run_job(conn, "followed_freeze", run_key or month, force=force) as ctx:
            if ctx is None:
                return {"status": "not_claimed"}
            res = followed.freeze(conn, today_et())
            if res["status"] != "frozen":
                ctx.skip(res["reason"])
                return res
            for cid in res["call_ids"]:
                spawn_grade(cid, "ex_ante", "none")
            return {"status": "frozen", "calls": len(res["call_ids"])}
    finally:
        conn.close()


def followed_grade(call_id: str, grade_type: str, horizon: str = "none") -> str:
    conn = db.sync_connect()
    try:
        return followed.grade_call(conn, _llm(), call_id, grade_type, horizon)
    finally:
        conn.close()


def factor_refresh(run_key: str | None = None, force: bool = False):
    return _guarded("factor_refresh", lambda conn, cal, s, ctx: {"rows": signals.refresh_factors(conn, s)},
                    run_key=run_key, force=force, needs="ingest_eod_bars")


# --- council + paper decisions -----------------------------------------------------------------
def _is_last_session_of_week_today() -> bool:
    conn = db.sync_connect()
    try:
        cal = universe.calendar_for(conn)
        session = cal.session_for(today_et())
        return session is None or cal.is_last_session_of_week(session)   # closed day: let _guarded skip as usual
    finally:
        conn.close()


def council_cycle(cadence: str, map_sessions: Callable[[list[str]], None], run_key: str | None = None, force: bool = False):
    job = f"council_{cadence}"
    if cadence == "weekly" and run_key is None and not force and not _is_last_session_of_week_today():
        # Skip WITHOUT claiming: the weekly key is per ISO week, so a recorded skip on Thursday would
        # make Friday's run "not_claimed" and the weekly council would never act.
        return {"status": "skipped", "reason": "not the last session of the ISO week"}

    def body(conn, cal, session, ctx):
        as_of = signals.compute_for_latest_session(conn)
        if as_of is None:
            ctx.skip("no complete session of bars")
            return {"status": "skipped"}
        ids = council_jobs.plan_scheduled_sessions(conn, cadence, as_of)
        map_sessions(ids)
        orders = paper.create_orders_for_cadence(conn, cadence, as_of, cal)
        return {"sessions": len(ids), **orders}
    key = run_key or (iso_week_key(today_et()) if cadence == "weekly" else None)
    return _guarded(job, body, run_key=key, force=force, needs="signals_pipeline" if cadence == "daily" else None)


def run_session(session_id: str, events=None) -> str:
    from nuwrrrld.core.council.debate import run_session as _run
    conn = db.sync_connect()
    try:
        return _run(session_id, council_jobs.PgSessionStore(conn), _llm(), events)
    finally:
        conn.close()


# --- Portfolio Intel / billing / ops --------------------------------------------------------------
def health_checks_weekly(spawn_check: Callable[[str], None], run_key: str | None = None, force: bool = False):
    conn = db.sync_connect()
    try:
        with run_job(conn, "health_checks_weekly", run_key or iso_week_key(today_et()), force=force) as ctx:
            if ctx is None:
                return {"status": "not_claimed"}
            ids = health.weekly_check_ids(conn)
            for cid in ids:
                spawn_check(cid)
            return {"queued": len(ids)}
    finally:
        conn.close()


def run_health_check(check_id: str) -> str:
    conn = db.sync_connect()
    try:
        return health.run_health_check(conn, _llm(), check_id)
    finally:
        conn.close()


def summarize_thread(thread_id: str) -> bool:
    """Roll older chat turns into chat_threads.summary with the fast model."""
    conn = db.sync_connect()
    try:
        rows = conn.execute("SELECT role, content FROM chat_messages WHERE thread_id=%s AND role IN ('user','assistant') "
                            "AND status='complete' ORDER BY created_at", (thread_id,)).fetchall()
        old = rows[:-16]
        if not old:
            return False
        text = "\n".join(f"{r['role']}: {r['content'][:600]}" for r in old)[-8000:]
        res = _llm().complete("chat", [{"role": "system", "content": "Summarize this conversation in under 120 words, keeping tickers and decisions discussed. No advice."},
                                       {"role": "user", "content": text}], model_tier="fast", max_output_tokens=220)
        conn.execute("UPDATE chat_threads SET summary=%s WHERE id=%s", (res.text, thread_id))
        return True
    finally:
        conn.close()


def _simple(job: str, key_fn, body, run_key=None, force=False):
    conn = db.sync_connect()
    try:
        with run_job(conn, job, run_key or key_fn(), force=force) as ctx:
            if ctx is None:
                return {"status": "not_claimed"}
            out = body(conn)
            ctx.detail.update({k: v for k, v in (out or {}).items() if isinstance(v, (int, float, str, bool))})
            return out
    finally:
        conn.close()


def _stripe():
    import os
    import stripe
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    return stripe


def trial_sweeper(run_key=None, force=False):
    now = dt.datetime.now(dt.timezone.utc)
    return _simple("trial_sweeper", lambda: now.strftime("%Y-%m-%dT%H"), lambda c: billing_jobs.trial_sweeper(c, now.strftime("%Y-%m-%dT%H")), run_key, force)


def billing_reconcile(run_key=None, force=False):
    return _simple("billing_reconcile", lambda: today_et().isoformat(), lambda c: billing_jobs.billing_reconcile(c, _stripe()), run_key, force)


def referral_qualifier(run_key=None, force=False):
    return _simple("referral_qualifier", lambda: today_et().isoformat(), lambda c: billing_jobs.referral_qualifier(c, _stripe()), run_key, force)


def calendar_refresh(run_key=None, force=False):
    return _simple("calendar_refresh", lambda: today_et().strftime("%Y-%m"), lambda c: {"rows": maintenance.calendar_refresh(c)}, run_key, force)


def maintenance_job(cache_dir: str | None, run_key=None, force=False):
    return _simple("maintenance", lambda: iso_week_key(today_et()), lambda c: maintenance.maintenance(c, cache_dir), run_key, force)


def backfill_gaps(repair: Callable[[dict], None], run_key=None, force=False):
    def body(conn):
        gaps = maintenance.gap_report(conn)
        repair(gaps)
        return {k: len(v) for k, v in gaps.items()}
    return _simple("backfill_gaps", lambda: today_et().isoformat(), body, run_key, force)


def watchdog(set_breaker: Callable[[bool], None]) -> list[str]:
    conn = db.sync_connect()
    try:
        alerts = maintenance.watchdog(conn, breaker_set=set_breaker)
        maintenance.post_alerts(alerts)
        return alerts
    finally:
        conn.close()
