"""Followed Tickers: monthly freeze, horizon scoring, LLM grading (Section 9.6)."""
from __future__ import annotations

import datetime as dt
import json
import logging
import math

import httpx

from nuwrrrld import dynamo
from nuwrrrld.calendar import TradingCalendar, today_et
from nuwrrrld.core import scoring
from nuwrrrld.jobs import universe
from nuwrrrld.llm import prompts
from nuwrrrld.llm.client import LLMBreakerOpen, LLMBudgetExceeded, LLMClient

log = logging.getLogger(__name__)
RUBRIC = ("evidence_use", "internal_consistency", "risk_awareness", "falsifiability", "timeframe_coherence")
LETTERS = ((90, "A"), (80, "B"), (70, "C"), (60, "D"))
SESSIONS_PER_YEAR = 252


def resolve_target(cal: TradingCalendar, entry: dt.date, sessions: int) -> dt.date:
    """Trading-session target; approximated by calendar days when the calendar doesn't reach that far
    (re-resolved lazily when the row comes due)."""
    try:
        return cal.add_sessions(entry, sessions)
    except Exception:
        return entry + dt.timedelta(days=math.ceil(sessions * 7 / 5))


def letter_grade(overall: float) -> str:
    for floor, letter in LETTERS:
        if overall >= floor:
            return letter
    return "F"


def freeze(conn, today: dt.date | None = None) -> dict:
    """Freeze the month's calls on the first trading session. Forward-only and idempotent."""
    cal = universe.calendar_for(conn)
    today = today or today_et()
    if not cal.is_first_session_of_month(today):
        return {"status": "skipped", "reason": "not the first trading session of the month"}
    month = today.replace(day=1)
    if conn.execute("SELECT 1 FROM followed_batches WHERE batch_month=%s", (month,)).fetchone():
        return {"status": "skipped", "reason": "batch exists"}
    run = conn.execute("SELECT id, as_of_date FROM signal_runs WHERE status='published' AND NOT is_backfill "
                       "ORDER BY as_of_date DESC LIMIT 1").fetchone()
    if run is None:
        return {"status": "skipped", "reason": "no published run"}
    universe_rows = conn.execute(
        """SELECT s.id, s.ticker, s.strength, s.explanation_md, s.fired_indicators, s.timeframe,
                  (SELECT value FROM indicator_values v WHERE v.ticker=s.ticker AND v.bar_date=s.as_of_date
                      AND v.indicator='adx_14' ORDER BY computed_at DESC LIMIT 1) AS adx,
                  (SELECT close FROM price_bars b WHERE b.ticker=s.ticker AND b.bar_date=s.as_of_date) AS entry_price,
                  (SELECT adj_close FROM price_bars b WHERE b.ticker=s.ticker AND b.bar_date=s.as_of_date) AS entry_adj,
                  (SELECT invalidation_price FROM hold_fold_verdicts h WHERE h.ticker=s.ticker AND h.as_of_date=s.as_of_date
                      AND h.scope='global' ORDER BY created_at DESC LIMIT 1) AS inval,
                  (SELECT position_side FROM hold_fold_verdicts h WHERE h.ticker=s.ticker AND h.as_of_date=s.as_of_date
                      AND h.scope='global' ORDER BY created_at DESC LIMIT 1) AS inval_side
             FROM signals s JOIN instruments i ON i.ticker=s.ticker
            WHERE s.run_id=%s AND i.is_tracked_etf AND i.active AND s.explanation_md IS NOT NULL""", (run["id"],)).fetchall()
    cands = []
    for r in universe_rows:
        dom = sum(abs(f["weight"]) for f in r["fired_indicators"] if f["timeframe"] == r["timeframe"])
        cands.append({**r, "strength": float(r["strength"]), "dominant_strength": dom, "adx": float(r["adx"] or 0)})
    chosen = scoring.select_calls(cands)
    selection = {"universe": "tracked_etfs", "ranking": "signed strength; ties |dominant| then ADX then ticker",
                 "entry_rule": "adjusted close of the run as_of_date", "bull_count": len(chosen["bull"]),
                 "bear_count": len(chosen["bear"]), "source_as_of": run["as_of_date"].isoformat()}
    batch = conn.execute(
        """INSERT INTO followed_batches (batch_month, freeze_session, source_signal_run, selection_rules)
           VALUES (%s,%s,%s,%s) ON CONFLICT (batch_month) DO NOTHING RETURNING id""",
        (month, today, run["id"], json.dumps(selection))).fetchone()
    if batch is None:
        return {"status": "skipped", "reason": "batch exists"}
    call_ids, call_rows, score_rows = [], [], []
    for side, calls in chosen.items():
        for rank, c in enumerate(calls, 1):
            side_ok = c["inval_side"] == ("long" if side == "bull" else "short")
            row = conn.execute(
                """INSERT INTO followed_calls (batch_id, side, rank, ticker, signal_id, conviction, entry_session, entry_price,
                                               invalidation_price, reasoning_md, fired_indicators, reasoning_sha256)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
                (batch["id"], side, rank, c["ticker"], c["id"], c["strength"], run["as_of_date"],
                 c["entry_adj"] or c["entry_price"], c["inval"] if side_ok else None, c["explanation_md"],
                 json.dumps(c["fired_indicators"]),
                 scoring.reasoning_sha256(c["explanation_md"], c["fired_indicators"]))).fetchone()
            call_ids.append(str(row["id"]))
            call_rows.append(row)
            for horizon, sessions in scoring.HORIZONS.items():
                conn.execute(
                    """INSERT INTO followed_horizon_scores (call_id, horizon, horizon_sessions, target_session)
                       VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                    (row["id"], horizon, sessions, resolve_target(cal, run["as_of_date"], sessions)))
                score_rows.append({"call_id": row["id"], "horizon": horizon, "status": "pending"})
    dynamo.mirror_rows("followed_calls", call_rows)
    return {"status": "frozen", "batch_id": str(batch["id"]), "call_ids": call_ids}


def score_due(conn, today: dt.date | None = None) -> dict:
    """Score pending horizons whose target session has been ingested. Frozen fields are never touched."""
    cal = universe.calendar_for(conn)
    latest = universe.latest_final_bar_date(conn)
    if latest is None:
        return {"scored": 0, "voided": 0}
    due = conn.execute(
        """SELECT h.call_id, h.horizon, h.horizon_sessions, h.target_session, c.side, c.entry_price, c.entry_session,
                  c.invalidation_price, c.ticker
             FROM followed_horizon_scores h JOIN followed_calls c ON c.id=h.call_id
            WHERE h.status='pending' AND h.target_session <= %s""", (latest,)).fetchall()
    scored = voided = 0
    out = []
    for d in due:
        true_target = resolve_target(cal, d["entry_session"], d["horizon_sessions"])
        if true_target != d["target_session"]:
            conn.execute("UPDATE followed_horizon_scores SET target_session=%s WHERE call_id=%s AND horizon=%s",
                         (true_target, d["call_id"], d["horizon"]))
            if true_target > latest:
                continue
        closes = [float(r["adj_close"]) for r in conn.execute(
            "SELECT adj_close FROM price_bars WHERE ticker=%s AND bar_date > %s AND bar_date <= %s ORDER BY bar_date",
            (d["ticker"], d["entry_session"], true_target)).fetchall()]
        bench = conn.execute(
            """SELECT (SELECT adj_close FROM price_bars WHERE ticker='SPY' AND bar_date=%s) AS e,
                      (SELECT adj_close FROM price_bars WHERE ticker='SPY' AND bar_date=%s) AS x""",
            (d["entry_session"], true_target)).fetchone()
        s = scoring.score_horizon(d["side"], float(d["entry_price"]), closes,
                                  float(bench["e"]) if bench["e"] else None, float(bench["x"]) if bench["x"] else None,
                                  float(d["invalidation_price"]) if d["invalidation_price"] else None)
        if s.status == "void":
            conn.execute("UPDATE followed_horizon_scores SET status='void', void_reason=%s, scored_at=now() "
                         "WHERE call_id=%s AND horizon=%s", (s.void_reason, d["call_id"], d["horizon"]))
            voided += 1
            continue
        conn.execute(
            """UPDATE followed_horizon_scores SET status='scored', exit_price=%s, raw_return=%s, directional_return=%s,
                      benchmark_return=%s, excess_return=%s, hit=%s, invalidated_before_target=%s,
                      max_adverse_excursion=%s, max_favorable_excursion=%s, scored_at=now()
                WHERE call_id=%s AND horizon=%s AND status='pending'""",
            (s.exit_price, s.raw_return, s.directional_return, s.benchmark_return, s.excess_return, s.hit,
             s.invalidated_before_target, s.max_adverse_excursion, s.max_favorable_excursion, d["call_id"], d["horizon"]))
        out.append({"call_id": d["call_id"], "horizon": d["horizon"], "directional_return": s.directional_return,
                    "excess_return": s.excess_return, "hit": s.hit})
        scored += 1
    dynamo.mirror_rows("followed_scores", out)
    return {"scored": scored, "voided": voided}


def _parse_rubric(obj: dict) -> dict:
    scores = {k: int(obj["rubric_scores"][k]) for k in RUBRIC}
    if any(not 1 <= v <= 5 for v in scores.values()):
        raise ValueError("rubric scores must be 1-5")
    return {"scores": scores, "rationale": str(obj["rationale_md"])}


def grade_call(conn, llm: LLMClient, call_id: str, grade_type: str, horizon: str = "none") -> str:
    """ex_ante (no outcome data) or ex_post (outcome shown). Unique per (call, type, horizon, prompt_version)."""
    system, version = prompts.load("followed")
    call = conn.execute("SELECT * FROM followed_calls WHERE id=%s", (call_id,)).fetchone()
    payload = {"ticker": call["ticker"], "side": call["side"], "entry_price": float(call["entry_price"]),
               "invalidation_price": float(call["invalidation_price"]) if call["invalidation_price"] else None,
               "reasoning_md": call["reasoning_md"], "fired_indicators": call["fired_indicators"]}
    if grade_type == "ex_post":
        s = conn.execute("SELECT * FROM followed_horizon_scores WHERE call_id=%s AND horizon=%s AND status='scored'",
                         (call_id, horizon)).fetchone()
        if s is None:
            return "not_scored"
        payload["outcome"] = {"horizon": horizon, "directional_return": float(s["directional_return"]),
                              "excess_return": float(s["excess_return"]) if s["excess_return"] is not None else None,
                              "hit": s["hit"]}
    try:
        res = llm.complete("followed_grade", [{"role": "system", "content": system},
                                              {"role": "user", "content": json.dumps({"grade_type": grade_type, **payload})}],
                           model_tier="smart", max_output_tokens=500, schema=_parse_rubric, ref_id=call_id)
    except (ValueError, LLMBreakerOpen, LLMBudgetExceeded, httpx.HTTPError) as exc:
        log.warning("grade_failed call=%s type=%s horizon=%s: %s", call_id, grade_type, horizon, exc)
        return "grade_failed"
    overall = round(sum(res.parsed["scores"].values()) / (5 * len(RUBRIC)) * 100, 2)
    row = conn.execute(
        """INSERT INTO followed_llm_grades (call_id, grade_type, horizon, model, prompt_version, rubric_scores,
                                            overall_score, letter_grade, rationale_md)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (call_id, grade_type, horizon, prompt_version) DO NOTHING
           RETURNING *""",
        (call_id, grade_type, horizon, res.model, version, json.dumps(res.parsed["scores"]), overall,
         letter_grade(overall), res.parsed["rationale"])).fetchone()
    if row:
        dynamo.mirror_rows("followed_grades", [row])
    return "graded" if row else "exists"
