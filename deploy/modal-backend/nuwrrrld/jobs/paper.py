"""Paper trading jobs: order creation, fills, snapshots + stops, corporate actions (Section 11)."""
from __future__ import annotations

import datetime as dt
import json
import logging
import time
from decimal import Decimal
from typing import Callable

from nuwrrrld import dynamo
from nuwrrrld.calendar import ET, TradingCalendar
from nuwrrrld.core.council.strategy import Proposal, build_strategy
from nuwrrrld.core.paper import fills, sizing
from nuwrrrld.jobs import universe

log = logging.getLogger(__name__)

OPEN_POLL_SECONDS = 300
OPEN_DEADLINE_ET = dt.time(10, 40)
OPEN_MISMATCH_TOLERANCE = Decimal("0.001")


# --- order creation ------------------------------------------------------------------------
def _portfolio_state(conn, p: dict, prices: dict[str, Decimal], sectors: dict[str, str | None], new_positions: int) -> sizing.PortfolioState:
    pos = conn.execute("SELECT ticker, quantity FROM paper_positions WHERE portfolio_id=%s", (p["id"],)).fetchall()
    positions = {r["ticker"]: (r["quantity"], prices.get(r["ticker"], Decimal(0)), sectors.get(r["ticker"])) for r in pos}
    long_v = sum(q * px for q, px, _ in positions.values() if q > 0)
    short_v = sum(-q * px for q, px, _ in positions.values() if q < 0)
    equity = p["cash"] + long_v - short_v
    return sizing.PortfolioState(p["status"], equity, p["cash"], positions, new_positions)


def _latest_prices(conn, tickers: list[str], as_of: dt.date) -> dict[str, Decimal]:
    rows = conn.execute("SELECT DISTINCT ON (ticker) ticker, close FROM price_bars WHERE ticker = ANY(%s) AND bar_date <= %s "
                        "ORDER BY ticker, bar_date DESC", (tickers, as_of)).fetchall()
    return {r["ticker"]: r["close"] for r in rows}


def _insert_order(conn, p: dict, session_id, ticker: str, plan: sizing.OrderPlan, decision: dt.date, target: dt.date,
                  expires: dt.date, inval: Decimal | None, status: str, reason: str | None) -> dict | None:
    key = f"{p['id']}:{decision}:{ticker}:{plan.intent}"
    return conn.execute(
        """INSERT INTO paper_orders (portfolio_id, session_id, ticker, side, quantity, order_type, intent, decision_date,
                                     target_session, expires_session, invalidation_price, status, reason, idempotency_key)
           VALUES (%s,%s,%s,%s,%s,'market_on_open',%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (idempotency_key) DO NOTHING RETURNING *""",
        (p["id"], session_id, ticker, plan.side, plan.quantity, plan.intent, decision, target, expires, inval, status, reason, key)).fetchone()


def create_orders_for_cadence(conn, cadence: str, as_of: dt.date, cal: TradingCalendar | None = None) -> dict:
    """Idempotent. A failed/no-consensus session creates no entries; existing positions change only via stops."""
    cal = cal or universe.calendar_for(conn)
    target = cal.next_session(as_of)
    latest_bar = universe.latest_final_bar_date(conn)
    date_ok = latest_bar == as_of
    created, rejected = [], 0
    sessions = conn.execute(
        """SELECT s.id, s.subject_ticker, c.direction, c.conviction, c.invalidation_price, c.reference_price, c.outcome
             FROM council_sessions s JOIN council_consensus c ON c.session_id=s.id
            WHERE s.cadence=%s AND s.as_of_date=%s AND s.trades_portfolios AND s.status='consensus'""", (cadence, as_of)).fetchall()
    portfolios = conn.execute("SELECT * FROM paper_portfolios WHERE cadence=%s AND status <> 'archived' AND NOT is_backtest",
                              (cadence,)).fetchall()
    tickers = sorted({s["subject_ticker"] for s in sessions} | {r["ticker"] for r in conn.execute(
        "SELECT DISTINCT ticker FROM paper_positions").fetchall()})
    if not tickers:
        return {"created": 0, "rejected": 0}
    prices = _latest_prices(conn, tickers, as_of)
    sectors = {r["ticker"]: r["sector"] for r in conn.execute("SELECT ticker, sector FROM instruments WHERE ticker = ANY(%s)", (tickers,)).fetchall()}
    for p in portfolios:
        rules = {**sizing.DEFAULT_RULES, **p["rules"]}
        expires = cal.add_sessions(target, max(0, rules["order_expiry_sessions"] - 1))
        new_positions = 0
        for s in sessions:
            ticker = s["subject_ticker"]
            price = prices.get(ticker)
            if price is None:
                continue
            state = _portfolio_state(conn, p, prices, sectors, new_positions)
            current = state.positions.get(ticker, (Decimal(0), price, None))[0]
            if p["owner_type"] == "council":
                tq = sizing.council_target_qty(state.equity, float(s["conviction"] or 0), s["reference_price"],
                                               s["invalidation_price"], s["direction"], rules)
                inval = s["invalidation_price"]
                if tq is not None and tq != 0 and current != 0 and inval is not None and (tq > 0) == (current > 0):
                    _tighten(conn, p["id"], ticker, inval, current)
            else:
                tq, inval = _member_target(conn, s["id"], p["member_id"], state.equity, price, rules)
            if tq is None:
                continue
            for plan in sizing.plan_orders(current, tq, price, state.equity, rules):
                reason = sizing.pre_trade_check(state, ticker, plan, price, sectors.get(ticker), rules, date_ok)
                row = _insert_order(conn, p, s["id"], ticker, plan, as_of, target, expires,
                                    inval if plan.intent in ("open", "increase") else None,
                                    "rejected" if reason else "pending", reason)
                if row is None:
                    continue
                if reason:
                    rejected += 1
                else:
                    created.append(row)
                    new_positions += 1 if plan.intent == "open" else 0
    dynamo.mirror_rows("paper_orders", created)
    return {"created": len(created), "rejected": rejected}


def _tighten(conn, portfolio_id, ticker: str, proposed: Decimal, qty: Decimal) -> None:
    pos = conn.execute("SELECT invalidation_price FROM paper_positions WHERE portfolio_id=%s AND ticker=%s", (portfolio_id, ticker)).fetchone()
    if pos is None:
        return
    new = fills.tighten(pos["invalidation_price"], proposed, qty)
    if new != pos["invalidation_price"]:
        conn.execute("UPDATE paper_positions SET invalidation_price=%s, updated_at=now() WHERE portfolio_id=%s AND ticker=%s",
                     (new, portfolio_id, ticker))


def _member_target(conn, session_id, member_id, equity: Decimal, price: Decimal, rules: dict) -> tuple[Decimal | None, Decimal | None]:
    from nuwrrrld.jobs.council import PgSessionStore
    vote = conn.execute(
        """SELECT v.direction, v.conviction, v.invalidation_price FROM council_votes v
            WHERE v.session_id=%s AND v.member_id=%s ORDER BY round DESC LIMIT 1""", (session_id, member_id)).fetchone()
    if vote is None:
        return None, None
    m = conn.execute("SELECT strategy_key, strategy_config FROM council_members WHERE id=%s", (member_id,)).fetchone()
    ctx, _, _ = PgSessionStore(conn).load_context(str(session_id))
    final = Proposal(vote["direction"], float(vote["conviction"]), vote["invalidation_price"], "final")
    weight = build_strategy(m["strategy_key"], m["strategy_config"]).target_weight(ctx, final)
    return sizing.member_target_qty(equity, weight, price, rules), vote["invalidation_price"]


# --- fills ----------------------------------------------------------------------------------------
def fill_pending(conn, provider, order_type: str, session: dt.date | None = None, *, now: Callable[[], dt.datetime] | None = None,
                 sleep: Callable[[float], None] | None = None) -> dict:
    """MOO: poll for the official open every 5 min until 10:40 ET; MOC: official close. Fills are final."""
    sleep = sleep or time.sleep
    clock = now or (lambda: dt.datetime.now(ET))
    cal = universe.calendar_for(conn)
    session = session or clock().date()
    if cal.session_for(session) is None:
        return {"status": "skipped"}
    conn.execute("UPDATE paper_orders SET status='expired', reason='expired unfilled', updated_at=now() "
                 "WHERE status='pending' AND expires_session < %s", (session,))
    filled, missing = [], []
    while True:
        pending = conn.execute("SELECT * FROM paper_orders WHERE status='pending' AND target_session=%s AND order_type=%s",
                               (session, order_type)).fetchall()
        if not pending:
            break
        tickers = sorted({o["ticker"] for o in pending})
        try:
            if order_type == "market_on_open":
                refs = {o.ticker: (o.open, o.source_field) for o in provider.session_open(tickers, session)}
            else:
                refs = {t: (px, "daily_bar.close") for t, px in provider.session_close(tickers, session).items()}
        except Exception as exc:  # DataNotReady or transient provider failure: keep polling
            log.warning("paper fill waiting for prices: %s", exc)
            refs = {}
        spreads: dict[str, Decimal | None] = {}
        for o in pending:
            if o["ticker"] not in refs:
                continue
            rules = {**sizing.DEFAULT_RULES, **conn.execute("SELECT rules FROM paper_portfolios WHERE id=%s", (o["portfolio_id"],)).fetchone()["rules"]}
            if o["ticker"] not in spreads:
                try:
                    spreads[o["ticker"]] = provider.spread_bps(o["ticker"])
                except Exception:
                    spreads[o["ticker"]] = None
            ref, src = refs[o["ticker"]]
            f = fills.fill_order(conn, o["id"], ref, spreads[o["ticker"]], rules, session, f"{provider.name}:{src}")
            if f:
                filled.append(f)
        remaining = conn.execute("SELECT count(*) AS n FROM paper_orders WHERE status='pending' AND target_session=%s AND order_type=%s",
                                 (session, order_type)).fetchone()["n"]
        if remaining == 0 or order_type != "market_on_open" or clock().time() >= OPEN_DEADLINE_ET:
            missing = remaining
            break
        sleep(OPEN_POLL_SECONDS)
    dynamo.mirror_rows("paper_fills", filled)
    return {"status": "done", "filled": len(filled), "unfilled": missing or 0}


def crosscheck_opens(conn, session: dt.date) -> list[str]:
    """After EOD ingest: flag fills whose reference open differs >0.1% from the EOD bar open. Never rewrites."""
    rows = conn.execute(
        """SELECT f.id, f.ticker, f.reference_price, b.open FROM paper_fills f
             JOIN paper_orders o ON o.id=f.order_id JOIN price_bars b ON b.ticker=f.ticker AND b.bar_date=f.session_date
            WHERE f.session_date=%s AND o.order_type='market_on_open'""", (session,)).fetchall()
    bad = [f"{r['ticker']}: fill ref {r['reference_price']} vs EOD open {r['open']}" for r in rows
           if r["open"] and abs(r["reference_price"] / r["open"] - 1) > OPEN_MISMATCH_TOLERANCE]
    for line in bad:
        log.error("OPEN MISMATCH %s", line)
    return bad


# --- corporate actions ---------------------------------------------------------------------------------
def apply_corporate_actions(conn, session: dt.date) -> int:
    """Splits/dividends once per (portfolio, action) via the ledger's unique (portfolio, kind, ref)."""
    applied = 0
    # Deterministic order: on a same-day split + dividend the dividend is paid on the PRE-split share count
    # (assumption: the vendor quotes the rate per pre-split share). Logged as a caveat in the docs.
    actions = conn.execute("SELECT * FROM corporate_actions WHERE ex_date <= %s AND applied_to_paper_at IS NULL "
                           "ORDER BY ex_date, CASE kind WHEN 'dividend' THEN 0 ELSE 1 END, ticker", (session,)).fetchall()
    for a in actions:
        ref = f"{a['kind']}:{a['ticker']}:{a['ex_date']}"
        for pos in conn.execute("SELECT p.* FROM paper_positions p WHERE p.ticker=%s", (a["ticker"],)).fetchall():
            if a["kind"] == "split":
                marker = conn.execute(
                    """INSERT INTO paper_cash_ledger (portfolio_id, session_date, kind, amount, ref)
                       VALUES (%s,%s,'adjustment',0,%s) ON CONFLICT (portfolio_id, kind, ref) DO NOTHING RETURNING id""",
                    (pos["portfolio_id"], session, ref)).fetchone()
                if marker:
                    r = a["ratio"]
                    conn.execute("UPDATE paper_positions SET quantity=quantity*%s, avg_cost=avg_cost/%s, "
                                 "invalidation_price=invalidation_price/%s WHERE portfolio_id=%s AND ticker=%s",
                                 (r, r, r, pos["portfolio_id"], a["ticker"]))
                    applied += 1
            else:
                amount = (pos["quantity"] * a["amount"]).quantize(Decimal("0.01"))
                marker = conn.execute(
                    """INSERT INTO paper_cash_ledger (portfolio_id, session_date, kind, amount, ref)
                       VALUES (%s,%s,'dividend',%s,%s) ON CONFLICT (portfolio_id, kind, ref) DO NOTHING RETURNING id""",
                    (pos["portfolio_id"], session, amount, ref)).fetchone()
                if marker:
                    conn.execute("UPDATE paper_portfolios SET cash = cash + %s WHERE id=%s", (amount, pos["portfolio_id"]))
                    applied += 1
        conn.execute("UPDATE corporate_actions SET applied_to_paper_at=now() WHERE ticker=%s AND ex_date=%s AND kind=%s",
                     (a["ticker"], a["ex_date"], a["kind"]))
    return applied


# --- snapshots + stops ---------------------------------------------------------------------------------
def snapshot_and_check_stops(conn, session: dt.date) -> dict:
    """Mark every portfolio to the close, update peak/halt, and queue stop_exit orders for breached stops."""
    cal = universe.calendar_for(conn)
    apply_corporate_actions(conn, session)
    target = cal.next_session(session)
    snaps, stops, halted = [], [], []
    spy = conn.execute("SELECT close FROM price_bars WHERE ticker='SPY' AND bar_date=%s", (session,)).fetchone()
    for p in conn.execute("SELECT * FROM paper_portfolios WHERE status <> 'archived' AND NOT is_backtest").fetchall():
        rules = {**sizing.DEFAULT_RULES, **p["rules"]}
        pos = conn.execute("SELECT * FROM paper_positions WHERE portfolio_id=%s", (p["id"],)).fetchall()
        prices = _latest_prices(conn, [x["ticker"] for x in pos], session)
        long_v = sum(x["quantity"] * prices[x["ticker"]] for x in pos if x["quantity"] > 0 and x["ticker"] in prices)
        short_v = sum(-x["quantity"] * prices[x["ticker"]] for x in pos if x["quantity"] < 0 and x["ticker"] in prices)
        equity = (p["cash"] + long_v - short_v).quantize(Decimal("0.01"))
        prev = conn.execute("SELECT equity FROM paper_equity_snapshots WHERE portfolio_id=%s AND session_date < %s "
                            "ORDER BY session_date DESC LIMIT 1", (p["id"], session)).fetchone()
        peak = max(p["peak_equity"] or Decimal(0), equity)
        daily = float(equity / prev["equity"] - 1) if prev and prev["equity"] else None
        drawdown = (equity / peak - 1) if peak > Decimal(0) else Decimal(0)
        cum_return = (equity / p["starting_cash"] - 1) if p["starting_cash"] and p["starting_cash"] > Decimal(0) else Decimal(0)
        snap = conn.execute(
            """INSERT INTO paper_equity_snapshots (portfolio_id, session_date, cash, long_value, short_value, equity,
                   gross_exposure, net_exposure, daily_return, cum_return, drawdown, benchmark_close)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (portfolio_id, session_date) DO UPDATE SET cash=EXCLUDED.cash, long_value=EXCLUDED.long_value,
                 short_value=EXCLUDED.short_value, equity=EXCLUDED.equity, gross_exposure=EXCLUDED.gross_exposure,
                 net_exposure=EXCLUDED.net_exposure, daily_return=EXCLUDED.daily_return, cum_return=EXCLUDED.cum_return,
                 drawdown=EXCLUDED.drawdown, benchmark_close=EXCLUDED.benchmark_close RETURNING *""",
            (p["id"], session, p["cash"], long_v, short_v, equity,
             (long_v + short_v) / equity if equity else 0, (long_v - short_v) / equity if equity else 0, daily,
             cum_return, drawdown, spy["close"] if spy else None)).fetchone()
        snaps.append(snap)
        conn.execute("UPDATE paper_portfolios SET peak_equity=%s WHERE id=%s", (peak, p["id"]))
        if p["status"] == "active" and peak > Decimal(0) and drawdown <= -Decimal(str(rules["drawdown_halt"])):
            conn.execute("UPDATE paper_portfolios SET status='halted' WHERE id=%s", (p["id"],))
            halted.append(str(p["id"]))
            log.error("ALERT portfolio halted by drawdown: %s", p["name"])
        for x in pos:
            px, inval = prices.get(x["ticker"]), x["invalidation_price"]
            if px is None or inval is None:
                continue
            if (x["quantity"] > 0 and px <= inval) or (x["quantity"] < 0 and px >= inval):
                plan = sizing.OrderPlan("sell" if x["quantity"] > 0 else "buy_to_cover", abs(x["quantity"]), "stop_exit")
                row = _insert_order(conn, p, None, x["ticker"], plan, session, target, target, None, "pending", None)
                if row:
                    stops.append(row)
    dynamo.mirror_rows("paper_equity", snaps)
    dynamo.mirror_rows("paper_orders", stops)
    return {"snapshots": len(snaps), "stop_exits": len(stops), "halted": halted}
