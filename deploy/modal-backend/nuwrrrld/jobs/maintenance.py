"""calendar_refresh, maintenance, backfill gap detection and the watchdog (Sections 7, 16, 18)."""
from __future__ import annotations

import datetime as dt
import logging
import os
import shutil
import time
from pathlib import Path

import httpx

from nuwrrrld import dynamo
from nuwrrrld.billing import users
from nuwrrrld.calendar import ET, ROLLING_MONTHS, TradingCalendar, today_et
from nuwrrrld.core.paper import fills
from nuwrrrld.jobs import universe

log = logging.getLogger(__name__)
GAP_WINDOW_SESSIONS = 10
CHAT_RETENTION_DAYS = 365
RAW_RETENTION_DAYS = 30
ALERT_DEDUPE_HOURS = 2
HEARTBEAT_STALE_MIN = 15


def calendar_refresh(conn, today: dt.date | None = None) -> int:
    """Rolling 18 months from exchange_calendars; manual overrides (source='manual') are preserved."""
    today = today or today_et()
    end = today + dt.timedelta(days=ROLLING_MONTHS * 31)
    rows = [{"d": r.session_date, "open": r.is_open, "o": r.open_at, "c": r.close_at, "e": r.is_early_close}
            for r in TradingCalendar().rows(today - dt.timedelta(days=7), end)]
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO trading_calendar (session_date, is_open, open_at, close_at, is_early_close)
               VALUES (%(d)s,%(open)s,%(o)s,%(c)s,%(e)s)
               ON CONFLICT (session_date) DO UPDATE SET is_open=EXCLUDED.is_open, open_at=EXCLUDED.open_at,
                 close_at=EXCLUDED.close_at, is_early_close=EXCLUDED.is_early_close
               WHERE trading_calendar.source <> 'manual'""", rows)
    return len(rows)


def maintenance(conn, cache_dir: str | None = None) -> dict:
    out = {}
    out["cache_pruned"] = conn.execute("WITH d AS (DELETE FROM market_data_cache WHERE expires_at < now() RETURNING 1) "
                                       "SELECT count(*) AS n FROM d").fetchone()["n"]
    out["chat_pruned"] = conn.execute(
        "WITH d AS (DELETE FROM chat_messages WHERE created_at < now() - make_interval(days => %s) RETURNING 1) SELECT count(*) AS n FROM d",
        (CHAT_RETENTION_DAYS,)).fetchone()["n"]
    out["users_purged"] = users.purge_deleted(conn)
    if cache_dir:
        cutoff = time.time() - RAW_RETENTION_DAYS * 86400
        raw = Path(cache_dir) / "raw"
        removed = 0
        if raw.exists():
            for day in raw.glob("*/*"):
                if day.is_dir() and day.stat().st_mtime < cutoff:
                    shutil.rmtree(day, ignore_errors=True)
                    removed += 1
        out["raw_dirs_removed"] = removed
    conn.execute("ANALYZE")
    return out


def gap_report(conn, today: dt.date | None = None, now: dt.datetime | None = None) -> dict:
    """Detect missing bars / signals / explanations / snapshots over the last 10 sessions + rebuild mismatches."""
    cal = universe.calendar_for(conn)
    current_dt = (now or dt.datetime.now(ET)).astimezone(ET)
    actual_today = current_dt.date()
    today = today or actual_today
    window = cal.sessions_between(today - dt.timedelta(days=20), today)[-GAP_WINDOW_SESSIONS:]
    tracked = universe.tracked_tickers(conn)
    gaps: dict[str, list] = {"bars": [], "signals": [], "explanations": [], "snapshots": [], "grades": [], "rebuild": []}
    for day in window:
        if day == actual_today and current_dt.time() < dt.time(18, 0):
            continue
        n = conn.execute("SELECT count(DISTINCT ticker) AS n FROM price_bars WHERE bar_date=%s AND ticker = ANY(%s)", (day, tracked)).fetchone()["n"]
        if n < len(tracked):
            gaps["bars"].append(day.isoformat())
            continue
        if not conn.execute("SELECT 1 FROM signal_runs WHERE as_of_date=%s", (day,)).fetchone():
            gaps["signals"].append(day.isoformat())
        if conn.execute("SELECT count(*) AS n FROM signals WHERE as_of_date=%s AND explanation_source='template'", (day,)).fetchone()["n"]:
            gaps["explanations"].append(day.isoformat())
        if conn.execute("SELECT 1 FROM paper_portfolios WHERE NOT is_backtest AND status<>'archived' AND NOT EXISTS "
                        "(SELECT 1 FROM paper_equity_snapshots s WHERE s.portfolio_id=paper_portfolios.id AND s.session_date=%s) "
                        "AND inception_date <= %s LIMIT 1", (day, day)).fetchone():
            gaps["snapshots"].append(day.isoformat())
    gaps["grades"] = [str(r["call_id"]) for r in conn.execute(
        """SELECT DISTINCT c.id AS call_id FROM followed_calls c WHERE NOT EXISTS
             (SELECT 1 FROM followed_llm_grades g WHERE g.call_id=c.id AND g.grade_type='ex_ante') LIMIT 50""").fetchall()]
    for p in conn.execute("SELECT id, name FROM paper_portfolios WHERE NOT is_backtest").fetchall():
        for issue in fills.verify_rebuild(conn, p["id"]):
            gaps["rebuild"].append(f"{p['name']}: {issue}")
    return gaps


# (job, run_key kind, deadline ET) - from the Section 7 schedule + Section 18 alert list
EXPECTATIONS = [
    ("paper_fill_close", dt.time(17, 0)), ("ingest_eod_bars", dt.time(18, 45)), ("equity_snapshots", dt.time(18, 30)),
    ("signals_pipeline", dt.time(19, 15)), ("council_daily", dt.time(19, 45)),
]


def watchdog(conn, now: dt.datetime | None = None, breaker_set=None) -> list[str]:
    now = now or dt.datetime.now(dt.timezone.utc)
    et = now.astimezone(ET)
    cal = universe.calendar_for(conn)
    alerts: list[str] = []
    trading_day = cal.is_session(et.date())
    if trading_day:
        for job, deadline in EXPECTATIONS:
            if et.time() < deadline:
                continue
            row = conn.execute("SELECT status FROM job_runs WHERE job_name=%s AND run_key=%s", (job, et.date().isoformat())).fetchone()
            if row is None or row["status"] not in ("succeeded", "skipped"):
                alerts.append(f"{job} not succeeded for {et.date()} by {deadline:%H:%M} ET (status={row['status'] if row else 'missing'})")
        if et.time() >= dt.time(10, 45):
            n = conn.execute("SELECT count(*) AS n FROM paper_orders WHERE status='pending' AND order_type='market_on_open' AND target_session=%s",
                             (et.date(),)).fetchone()["n"]
            if n:
                alerts.append(f"{n} MOO paper orders still pending after 10:45 ET")
        if et.time() >= dt.time(7, 15):
            unpublished = conn.execute(
                """SELECT as_of_date FROM signal_runs WHERE status IN ('computed','explained') AND NOT is_backfill
                   AND as_of_date > COALESCE((SELECT max(as_of_date) FROM signal_runs WHERE status='published'),'epoch') LIMIT 1""").fetchone()
            if unpublished and et.time() < dt.time(18, 0):
                alerts.append(f"digest for {unpublished['as_of_date']} not published by 07:15 ET")
    for r in conn.execute("SELECT job_name, run_key FROM job_runs WHERE status='failed' AND finished_at > now() - interval '1 day'").fetchall():
        alerts.append(f"job failed after retries: {r['job_name']} {r['run_key']}")
    for r in conn.execute("SELECT job_name, run_key FROM job_runs WHERE status='running' AND heartbeat_at < now() - make_interval(mins => %s)",
                          (HEARTBEAT_STALE_MIN,)).fetchall():
        alerts.append(f"stale heartbeat: {r['job_name']} {r['run_key']}")
    n = conn.execute("SELECT count(*) AS n FROM council_sessions WHERE status='running' AND started_at < now() - interval '30 minutes'").fetchone()["n"]
    if n:
        alerts.append(f"{n} council session(s) running > 30 min")
    n = conn.execute("SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NULL AND received_at < now() - interval '1 hour'").fetchone()["n"]
    if n:
        alerts.append(f"{n} webhook event(s) unprocessed > 1h")
    spend = conn.execute("SELECT COALESCE(sum(est_cost_usd),0) AS s FROM llm_usage WHERE created_at >= %s", (dt.datetime.combine(et.date(), dt.time(0), tzinfo=ET),)).fetchone()["s"]
    budget = float(os.environ.get("LLM_DAILY_BUDGET_USD", "25"))
    if budget and float(spend) >= 0.8 * budget:
        alerts.append(f"LLM spend ${float(spend):.2f} is >= 80% of the ${budget:.2f} daily budget")
    if breaker_set is not None:
        breaker_set(bool(budget and float(spend) >= budget))
    fresh = []
    for a in alerts:
        seen = conn.execute("SELECT 1 FROM audit_log WHERE action='watchdog.alert' AND target=%s AND created_at > now() - make_interval(hours => %s)",
                            (a, ALERT_DEDUPE_HOURS)).fetchone()
        if not seen:
            conn.execute("INSERT INTO audit_log (actor, action, target) VALUES ('system','watchdog.alert',%s)", (a,))
            fresh.append(a)
    return fresh


def post_alerts(alerts: list[str]) -> None:
    url = os.environ.get("ALERT_WEBHOOK_URL")
    if not alerts:
        return
    for a in alerts:
        log.error("ALERT %s", a)
    if url:
        try:
            httpx.post(url, json={"text": "NuWrrrld watchdog:\n" + "\n".join(f"- {a}" for a in alerts)}, timeout=10.0)
        except httpx.HTTPError as exc:
            log.warning("alert webhook failed: %s", exc)
