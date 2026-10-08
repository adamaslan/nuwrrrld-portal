"""signals_pipeline stages: indicators -> signals -> hold/fold -> sector rotation -> alerts -> factors."""
from __future__ import annotations

import datetime as dt
import json
import logging

import pandas as pd

from nuwrrrld import ENGINE_VERSION, dynamo
from nuwrrrld.core import holdfold, indicators, rotation, signals as rules
from nuwrrrld.jobs import universe

log = logging.getLogger(__name__)

SWING_WINDOW = 20      # sessions used for the structure-based invalidation level
FACTOR_BETA_WINDOW = 252


def compute_for_latest_session(conn) -> dt.date | None:
    """Latest session with a complete set of final bars for every tracked ETF, else None (holiday / missing)."""
    tracked = universe.tracked_tickers(conn)
    row = conn.execute(
        """SELECT bar_date FROM price_bars WHERE ticker = ANY(%s) AND is_final
           GROUP BY bar_date HAVING count(DISTINCT ticker) = %s ORDER BY bar_date DESC LIMIT 1""",
        (tracked, len(tracked))).fetchone()
    return row["bar_date"] if row else None


def _frames(conn, as_of: dt.date):
    tracked = universe.tracked_tickers(conn)
    bench = universe.benchmark_tickers(conn)
    bars = universe.load_bars(conn, sorted(set(tracked) | set(bench)), as_of)
    bench_df = bars.get(universe.BENCHMARK_DEFAULT)
    frames = {t: indicators.compute_indicator_frame(bars[t], bench_df) for t in tracked if t in bars}
    return tracked, bars, frames


def generate(conn, as_of: dt.date, engine_version: str = ENGINE_VERSION, is_backfill: bool = False) -> tuple[str, list[str]]:
    """Deterministic. Re-running converges: run row keyed (as_of, engine_version); signals keyed (run_id, ticker)."""
    run = conn.execute(
        """INSERT INTO signal_runs (as_of_date, engine_version, is_backfill, status) VALUES (%s,%s,%s,'running')
           ON CONFLICT (as_of_date, engine_version) DO NOTHING RETURNING id, status""",
        (as_of, engine_version, is_backfill)).fetchone()
    if run is None:
        run = conn.execute("SELECT id, status FROM signal_runs WHERE as_of_date=%s AND engine_version=%s",
                           (as_of, engine_version)).fetchone()
        if run["status"] in ("explained", "published"):
            ids = [r["id"] for r in conn.execute("SELECT id FROM signals WHERE run_id=%s", (run["id"],)).fetchall()]
            return str(run["id"]), [str(i) for i in ids]
        conn.execute("UPDATE signal_runs SET status='running', started_at=now() WHERE id=%s", (run["id"],))
    run_id = run["id"]
    tracked, bars, frames = _frames(conn, as_of)
    ts = pd.Timestamp(as_of)
    signal_ids, ind_rows, sig_rows = [], [], []
    for ticker in tracked:
        frame = frames.get(ticker)
        if frame is None or ts not in frame.index:
            log.warning("no bar for %s on %s; skipped from run", ticker, as_of)
            continue
        latest, prev = indicators.latest_readings(frame, ts)
        ind_rows.extend(indicators.to_indicator_rows(ticker, as_of, latest, engine_version))
        result = rules.evaluate(ticker, latest, prev)
        row = conn.execute(
            """INSERT INTO signals (run_id, ticker, as_of_date, direction, strength, timeframe, horizon_days, fired_indicators)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (run_id, ticker) DO UPDATE SET direction=EXCLUDED.direction, strength=EXCLUDED.strength,
                 timeframe=EXCLUDED.timeframe, horizon_days=EXCLUDED.horizon_days, fired_indicators=EXCLUDED.fired_indicators
               RETURNING id""",
            (run_id, ticker, as_of, result.direction, result.strength, result.timeframe, result.horizon_days,
             json.dumps(result.fired_indicators))).fetchone()
        signal_ids.append(str(row["id"]))
        sig_rows.append({"ticker": ticker, "as_of_date": as_of, "direction": result.direction,
                         "strength": result.strength, "timeframe": result.timeframe,
                         "horizon_days": result.horizon_days, "fired_indicators": result.fired_indicators,
                         "run_id": run_id})
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO indicator_values (ticker, bar_date, indicator, value, components, engine_version)
               VALUES (%(ticker)s,%(bar_date)s,%(indicator)s,%(value)s,%(components)s,%(engine_version)s)
               ON CONFLICT (ticker, bar_date, indicator, engine_version) DO UPDATE
                 SET value=EXCLUDED.value, components=EXCLUDED.components, computed_at=now()""",
            [{**r, "components": json.dumps(r["components"])} for r in ind_rows])
    conn.execute("UPDATE signal_runs SET status='computed', finished_at=now(), stats=%s WHERE id=%s",
                 (json.dumps({"signals": len(signal_ids), "tracked": len(tracked)}), run_id))
    dynamo.mirror_rows("indicator_values", ind_rows)
    dynamo.mirror_rows("signals", sig_rows)
    dynamo.mirror_rows("signal_runs", [{"as_of_date": as_of, "engine_version": engine_version, "run_id": run_id,
                                        "status": "computed", "signals": len(signal_ids)}])
    return str(run_id), signal_ids


def generate_backfill(conn, as_of: str) -> str:
    """is_backfill=True: appears in history but never triggers alerts, council sessions or orders."""
    run_id, _ = generate(conn, dt.date.fromisoformat(as_of), is_backfill=True)
    return run_id


def _swing(frame: pd.DataFrame, bars: pd.DataFrame, ts) -> tuple[float | None, float | None]:
    window = bars.loc[:ts].tail(SWING_WINDOW)
    return (float(window["low"].min()), float(window["high"].max())) if not window.empty else (None, None)


def generate_hold_fold(conn, as_of: dt.date, engine_version: str = ENGINE_VERSION) -> int:
    """Global verdict per tracked ETF. The unique key is (ticker, date, engine), so one row per ETF: it
    reports the side the bias supports (long unless bearish)."""
    tracked, bars, frames = _frames(conn, as_of)
    ts = pd.Timestamp(as_of)
    out = []
    for ticker in tracked:
        frame = frames.get(ticker)
        if frame is None or ts not in frame.index:
            continue
        latest, _ = indicators.latest_readings(frame, ts)
        lo, hi = _swing(frame, bars[ticker], ts)
        peak = float(bars[ticker]["close"].loc[:ts].tail(252).max())
        drawdown = latest["close"] / peak - 1 if latest.get("close") and peak else None
        side = "short" if holdfold.bias_from(latest) == "bearish" else "long"
        v = holdfold.compute(ticker, side, latest, lo, hi, drawdown)
        conn.execute(
            """INSERT INTO hold_fold_verdicts (ticker, as_of_date, scope, position_side, verdict, bias, risk_level,
                                               vol_regime, readings, invalidation_price, engine_version)
               VALUES (%s,%s,'global',%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (ticker, as_of_date, engine_version) WHERE scope='global' DO UPDATE SET
                 position_side=EXCLUDED.position_side, verdict=EXCLUDED.verdict, bias=EXCLUDED.bias,
                 risk_level=EXCLUDED.risk_level, vol_regime=EXCLUDED.vol_regime, readings=EXCLUDED.readings,
                 invalidation_price=EXCLUDED.invalidation_price""",
            (ticker, as_of, v.position_side, v.verdict, v.bias, v.risk_level, v.vol_regime, json.dumps(v.readings),
             v.invalidation_price, engine_version))
        out.append({"ticker": ticker, "as_of_date": as_of, "scope": "global", "verdict": v.verdict, "bias": v.bias,
                    "risk_level": v.risk_level, "vol_regime": v.vol_regime, "position_side": v.position_side,
                    "invalidation_price": v.invalidation_price, "readings": v.readings})
    dynamo.mirror_rows("hold_fold", out)
    return len(out)


def compute_sector_rotation(conn, as_of: dt.date) -> int:
    tracked = universe.tracked_tickers(conn)
    bars = universe.load_bars(conn, sorted(set(tracked) | {universe.BENCHMARK_DEFAULT}), as_of)
    bench = bars.get(universe.BENCHMARK_DEFAULT)
    if bench is None:
        return 0
    closes = {t: bars[t]["close"] for t in tracked if t in bars}
    rows = rotation.snapshot(closes, bench["close"], pd.Timestamp(as_of))
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO sector_rotation_snapshots (as_of_date, ticker, rs_ratio, rs_momentum, quadrant, rank)
               VALUES (%(as_of_date)s,%(ticker)s,%(rs_ratio)s,%(rs_momentum)s,%(quadrant)s,%(rank)s)
               ON CONFLICT (as_of_date, ticker) DO UPDATE SET rs_ratio=EXCLUDED.rs_ratio,
                 rs_momentum=EXCLUDED.rs_momentum, quadrant=EXCLUDED.quadrant, rank=EXCLUDED.rank""", rows)
    dynamo.mirror_rows("sector_rotation", rows)
    return len(rows)


def evaluate_watchlist_alerts(conn, as_of: dt.date) -> int:
    """signal_flip / hold_fold_change / quadrant_change vs the previous session. Unique per (user,ticker,date,kind)."""
    prev = conn.execute("SELECT max(as_of_date) AS d FROM signal_runs WHERE as_of_date < %s AND NOT is_backfill",
                        (as_of,)).fetchone()["d"]
    if prev is None:
        return 0
    items = conn.execute(
        """SELECT w.user_id, wi.ticker, wi.alert_rules FROM watchlist_items wi JOIN watchlists w ON w.id = wi.watchlist_id
           WHERE wi.alert_rules <> '{}'::jsonb""").fetchall()
    created = 0
    for it in items:
        rules_ = it["alert_rules"]
        checks = []
        if rules_.get("signal_flip"):
            checks.append(("signal_flip", "SELECT direction AS v FROM signals WHERE ticker=%s AND as_of_date=%s"))
        if rules_.get("hold_fold_change"):
            checks.append(("hold_fold_change", "SELECT verdict AS v FROM hold_fold_verdicts WHERE ticker=%s AND as_of_date=%s AND scope='global'"))
        if rules_.get("quadrant_change"):
            checks.append(("quadrant_change", "SELECT quadrant AS v FROM sector_rotation_snapshots WHERE ticker=%s AND as_of_date=%s"))
        for kind, sql in checks:
            now_row = conn.execute(sql, (it["ticker"], as_of)).fetchone()
            old_row = conn.execute(sql, (it["ticker"], prev)).fetchone()
            if now_row and old_row and now_row["v"] != old_row["v"]:
                r = conn.execute(
                    """INSERT INTO user_alerts (user_id, ticker, as_of_date, kind, payload) VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (user_id, ticker, as_of_date, kind) DO NOTHING RETURNING id""",
                    (it["user_id"], it["ticker"], as_of, kind,
                     json.dumps({"from": old_row["v"], "to": now_row["v"], "previous_date": prev.isoformat()}))).fetchone()
                created += 1 if r else 0
    return created


def refresh_factors(conn, as_of: dt.date) -> int:
    """beta_spy_252, mom_12_1, vol_63, drawdown_252 for tracked ETFs and held instruments."""
    held = [r["ticker"] for r in conn.execute("SELECT DISTINCT ticker FROM holdings").fetchall()]
    tickers = sorted(set(universe.tracked_tickers(conn)) | set(held))
    bars = universe.load_bars(conn, sorted(set(tickers) | {universe.BENCHMARK_DEFAULT}), as_of, days=420)
    bench = bars.get(universe.BENCHMARK_DEFAULT)
    if bench is None:
        return 0
    brets = bench["close"].pct_change()
    rows = []
    for t in tickers:
        if t not in bars or len(bars[t]) < 130:
            continue
        c = bars[t]["close"]
        rets = c.pct_change()
        joined = pd.concat([rets, brets], axis=1, keys=["a", "b"]).dropna().tail(FACTOR_BETA_WINDOW)
        factors = {"vol_63": float(rets.tail(63).std(ddof=0) * (252 ** 0.5)),
                   "drawdown_252": float(c.iloc[-1] / c.tail(252).max() - 1)}
        if len(joined) > 60 and joined["b"].var() > 0:
            factors["beta_spy_252"] = float(joined["a"].cov(joined["b"]) / joined["b"].var())
        if len(c) > 252:
            factors["mom_12_1"] = float(c.iloc[-22] / c.iloc[-252] - 1)
        rows.extend({"ticker": t, "as_of_date": as_of, "factor": k, "value": round(v, 8), "source": "computed"}
                    for k, v in factors.items() if v == v)
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO factor_exposures (ticker, as_of_date, factor, value, source)
               VALUES (%(ticker)s,%(as_of_date)s,%(factor)s,%(value)s,%(source)s)
               ON CONFLICT (ticker, as_of_date, factor) DO UPDATE SET value=EXCLUDED.value""", rows)
    dynamo.mirror_rows("factor_exposures", rows)
    return len(rows)
