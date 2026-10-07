"""Read-only universe/calendar/bar helpers shared by jobs and the backfill entrypoint."""
from __future__ import annotations

import datetime as dt

import pandas as pd

from nuwrrrld.calendar import TradingCalendar

BENCHMARK_DEFAULT = "SPY"
HISTORY_DAYS = 420     # enough for sma_200 / 252-session windows


def tracked_tickers(conn) -> list[str]:
    return [r["ticker"] for r in conn.execute(
        "SELECT ticker FROM instruments WHERE is_tracked_etf AND active ORDER BY ticker").fetchall()]


def benchmark_tickers(conn) -> list[str]:
    rows = conn.execute("SELECT DISTINCT benchmark AS b FROM instruments WHERE benchmark IS NOT NULL").fetchall()
    return sorted({r["b"] for r in rows} | {BENCHMARK_DEFAULT})


def calendar_for(conn) -> TradingCalendar:
    closed = frozenset(r["session_date"] for r in conn.execute(
        "SELECT session_date FROM trading_calendar WHERE source='manual' AND NOT is_open").fetchall())
    return TradingCalendar(closed)


def trading_days(start: str, end: str, conn=None) -> list[str]:
    cal = calendar_for(conn) if conn is not None else TradingCalendar()
    return [d.isoformat() for d in cal.sessions_between(dt.date.fromisoformat(start), dt.date.fromisoformat(end))]


def load_bars(conn, tickers: list[str], as_of: dt.date, days: int = HISTORY_DAYS) -> dict[str, pd.DataFrame]:
    """Split/dividend-adjusted OHLCV frames indexed by date, using ONLY rows with bar_date <= as_of."""
    rows = conn.execute(
        """SELECT ticker, bar_date, open, high, low, close, volume, adj_close, adj_factor
             FROM price_bars WHERE ticker = ANY(%s) AND timeframe='1d' AND bar_date <= %s AND bar_date > %s
             ORDER BY ticker, bar_date""", (tickers, as_of, as_of - dt.timedelta(days=days))).fetchall()
    if not rows:
        return {}
    df = pd.DataFrame(rows)
    for col in ("open", "high", "low", "close", "volume", "adj_close", "adj_factor"):
        df[col] = pd.to_numeric(df[col])
    out: dict[str, pd.DataFrame] = {}
    for ticker, g in df.groupby("ticker"):
        g = g.set_index(pd.to_datetime(g["bar_date"])).sort_index()
        factor = (g["adj_close"] / g["close"]).where(g["close"] != 0, 1.0).fillna(1.0)
        out[ticker] = pd.DataFrame({"open": g["open"] * factor, "high": g["high"] * factor, "low": g["low"] * factor,
                                    "close": g["adj_close"], "volume": g["volume"]})
    return out


def latest_final_bar_date(conn) -> dt.date | None:
    row = conn.execute("SELECT max(bar_date) AS d FROM price_bars WHERE is_final").fetchone()
    return row["d"] if row else None
