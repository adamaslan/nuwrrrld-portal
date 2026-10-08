"""Exactly-once fill transaction + position/cash accounting + rebuild (Section 11.4 / 11.6).

psycopg connection must be autocommit=True; `conn.transaction()` opens the explicit transaction.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

BPS = Decimal(10_000)
PRICE_QUANT = Decimal("0.000001")
MONEY_QUANT = Decimal("0.01")


def fill_price(ref_price: Decimal, side: str, slippage_bps: Decimal, spread_bps: Decimal) -> Decimal:
    """Pay up on buys, give up on sells: ref * (1 +/- (slippage + spread/2)/1e4)."""
    bps = slippage_bps + spread_bps / 2
    sign = 1 if side in ("buy", "buy_to_cover") else -1
    return (ref_price * (1 + sign * bps / BPS)).quantize(PRICE_QUANT)


def next_position(qty0: Decimal, avg0: Decimal, signed: Decimal, price: Decimal) -> tuple[Decimal, Decimal, bool]:
    """Return (new_qty, new_avg_cost, reset_opened) after applying `signed` at `price`."""
    new = qty0 + signed
    if new == 0:
        return Decimal(0), Decimal(0), False
    if qty0 == 0:
        return new, price, True
    if (qty0 > 0) == (signed > 0):                       # adding to the position
        return new, (abs(qty0) * avg0 + abs(signed) * price) / abs(new), False
    if (new > 0) == (qty0 > 0):                          # partial reduction keeps the cost basis
        return new, avg0, False
    return new, price, True                              # flipped through zero


def apply_fill(conn, order: dict, price: Decimal, commission: Decimal, fill_id, session_date: date) -> None:
    signed = order["quantity"] if order["side"] in ("buy", "buy_to_cover") else -order["quantity"]
    notional = (signed * price).quantize(MONEY_QUANT)
    pos = conn.execute("SELECT quantity, avg_cost, invalidation_price FROM paper_positions "
                       "WHERE portfolio_id=%s AND ticker=%s FOR UPDATE",
                       (order["portfolio_id"], order["ticker"])).fetchone()
    qty0, avg0 = (pos["quantity"], pos["avg_cost"]) if pos else (Decimal(0), Decimal(0))
    qty1, avg1, reset = next_position(qty0, avg0, signed, price)
    if qty1 == 0:
        conn.execute("DELETE FROM paper_positions WHERE portfolio_id=%s AND ticker=%s",
                     (order["portfolio_id"], order["ticker"]))
    elif pos is None:
        conn.execute(
            """INSERT INTO paper_positions (portfolio_id, ticker, quantity, avg_cost, invalidation_price,
                                            opened_session, last_session_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (order["portfolio_id"], order["ticker"], qty1, avg1, order["invalidation_price"], session_date,
             order["session_id"]))
    else:
        inval = order["invalidation_price"] if reset else tighten(pos["invalidation_price"], order["invalidation_price"], qty1)
        conn.execute(
            """UPDATE paper_positions SET quantity=%s, avg_cost=%s, invalidation_price=%s,
                      opened_session = CASE WHEN %s THEN %s ELSE opened_session END,
                      last_session_id=COALESCE(%s,last_session_id), updated_at=now()
               WHERE portfolio_id=%s AND ticker=%s""",
            (qty1, avg1, inval, reset, session_date, order["session_id"], order["portfolio_id"], order["ticker"]))
    conn.execute("INSERT INTO paper_cash_ledger (portfolio_id, session_date, kind, amount, ref) VALUES (%s,%s,'fill',%s,%s) "
                 "ON CONFLICT (portfolio_id, kind, ref) DO NOTHING",
                 (order["portfolio_id"], session_date, -notional, str(fill_id)))
    if commission:
        conn.execute("INSERT INTO paper_cash_ledger (portfolio_id, session_date, kind, amount, ref) VALUES (%s,%s,'commission',%s,%s) "
                     "ON CONFLICT (portfolio_id, kind, ref) DO NOTHING",
                     (order["portfolio_id"], session_date, -commission, str(fill_id)))
    conn.execute("UPDATE paper_portfolios SET cash = cash + %s WHERE id=%s",
                 (-notional - commission, order["portfolio_id"]))


def tighten(current: Decimal | None, proposed: Decimal | None, qty: Decimal) -> Decimal | None:
    """A stop may only move toward price (tighten): up for longs, down for shorts."""
    if proposed is None:
        return current
    if current is None:
        return proposed
    return max(current, proposed) if qty > 0 else min(current, proposed)


def fill_order(conn, order_id, ref_price: Decimal, spread_bps: Decimal | None, rules: dict,
               session_date: date, source: str) -> dict | None:
    """Fill one pending order exactly once. Returns the fill row, or None if already handled."""
    with conn.transaction():
        o = conn.execute("SELECT * FROM paper_orders WHERE id=%s AND status='pending' FOR UPDATE", (order_id,)).fetchone()
        if o is None:
            return None
        spread = spread_bps if spread_bps is not None else Decimal(str(rules["spread_bps_fallback"]))
        slip = Decimal(str(rules["slippage_bps"]))
        price = fill_price(ref_price, o["side"], slip, spread)
        commission = Decimal(str(rules["commission_per_order"]))
        fill = conn.execute(
            """INSERT INTO paper_fills (order_id, portfolio_id, ticker, side, quantity, reference_price, fill_price,
                                        slippage_bps, commission, session_date, price_source)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *""",
            (o["id"], o["portfolio_id"], o["ticker"], o["side"], o["quantity"], ref_price, price,
             slip + spread / 2, commission, session_date, source)).fetchone()
        apply_fill(conn, o, price, commission, fill["id"], session_date)
        conn.execute("UPDATE paper_orders SET status='filled', updated_at=now() WHERE id=%s", (o["id"],))
        return fill


def rebuild_positions(conn, portfolio_id) -> tuple[dict[str, tuple[Decimal, Decimal]], Decimal]:
    """Replay fills + ledger from inception -> ({ticker: (qty, avg_cost)}, cash). Read-only."""
    p = conn.execute("SELECT starting_cash FROM paper_portfolios WHERE id=%s", (portfolio_id,)).fetchone()
    fills = conn.execute("SELECT * FROM paper_fills WHERE portfolio_id=%s ORDER BY filled_at, id", (portfolio_id,)).fetchall()
    book: dict[str, tuple[Decimal, Decimal]] = {}
    for f in fills:
        signed = f["quantity"] if f["side"] in ("buy", "buy_to_cover") else -f["quantity"]
        q0, a0 = book.get(f["ticker"], (Decimal(0), Decimal(0)))
        q1, a1, _ = next_position(q0, a0, signed, f["fill_price"])
        if q1 == 0:
            book.pop(f["ticker"], None)
        else:
            book[f["ticker"]] = (q1, a1)
    ledger = conn.execute("SELECT COALESCE(SUM(amount),0) AS s FROM paper_cash_ledger WHERE portfolio_id=%s",
                          (portfolio_id,)).fetchone()["s"]
    return book, (p["starting_cash"] + ledger).quantize(MONEY_QUANT)


def verify_rebuild(conn, portfolio_id, tol: Decimal = Decimal("0.01")) -> list[str]:
    """Return mismatch descriptions between the live tables and a replay (empty = consistent)."""
    book, cash = rebuild_positions(conn, portfolio_id)
    live = {r["ticker"]: r for r in conn.execute(
        "SELECT ticker, quantity, avg_cost FROM paper_positions WHERE portfolio_id=%s", (portfolio_id,)).fetchall()}
    issues = []
    for t in set(book) | set(live):
        q = book.get(t, (Decimal(0), None))[0]
        lq = live[t]["quantity"] if t in live else Decimal(0)
        if abs(q - lq) > Decimal("0.000001"):
            issues.append(f"{t}: replay qty {q} != live {lq}")
    live_cash = conn.execute("SELECT cash FROM paper_portfolios WHERE id=%s", (portfolio_id,)).fetchone()["cash"]
    if abs(live_cash - cash) > tol:
        issues.append(f"cash: replay {cash} != live {live_cash}")
    return issues
