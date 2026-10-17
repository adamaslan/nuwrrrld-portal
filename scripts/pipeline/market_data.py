"""Alpaca-first market data loader shared by locrun.py and refresh-signals.py.

Alpaca (SIP daily bars + IEX snapshot) is primary; yfinance fills only the tickers
Alpaca could not serve, and every such fall-through is logged at WARNING. This
module runs on the laptop only, so the yfinance fallback is allowed here (Yahoo
blocks cloud IPs; see ~/.claude/rules/market-data-fallback.md).
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

import yfinance as yf

import alpaca_md

log = logging.getLogger("market_data")

_REPO_ROOT = Path(__file__).resolve().parents[2]
# A git worktree has no .env.local; fall back to the primary checkout next to it.
PORTAL_ENV_FILE = next(
    (p for p in (_REPO_ROOT / ".env.local", _REPO_ROOT.parent / "nuwrrrld-portal" / ".env.local") if p.exists()),
    _REPO_ROOT / ".env.local",
)
ALPACA_ENV_NAMES = ("ALPACA_API_KEY", "ALPACA_API_SECRET")


def _load_alpaca_keys() -> None:
    """The Alpaca paper keys live in the portal's .env.local; load only those two names."""
    if all(os.environ.get(n) for n in ALPACA_ENV_NAMES) or not PORTAL_ENV_FILE.exists():
        return
    try:
        from dotenv import dotenv_values
    except ImportError:
        return
    values = dotenv_values(PORTAL_ENV_FILE)
    for name in ALPACA_ENV_NAMES:
        if values.get(name):
            os.environ.setdefault(name, values[name])


_load_alpaca_keys()

# Calendar days to request per --period; 3mo of daily bars plus a buffer for holidays.
# 1mo is deliberately absent: ~21 trading days can never reach MIN_BARS.
PERIOD_DAYS = {"3mo": 120, "6mo": 220, "1y": 400}
PERIOD_CHOICES = tuple(PERIOD_DAYS)

# MACD(12, 26) plus its 9-bar signal line first has a valid value at bar 34.
MIN_BARS = 34


def load_market_data(tickers: list[str], period: str) -> dict[str, dict]:
    """Alpaca first (SIP bars + IEX snapshot); yfinance only for tickers Alpaca could not serve.

    Returns {ticker: {"df", "price", "prev_close", "data_as_of", "source"}}.
    """
    days = PERIOD_DAYS[period]
    data: dict[str, dict] = {}
    if alpaca_md.is_configured():
        try:
            frames = alpaca_md.daily_bars_frames(tickers, days)
            quotes = alpaca_md.latest_prices(list(frames))
        except alpaca_md.AlpacaError as exc:
            frames, quotes = {}, {}
            alpaca_md.warn_fallback("daily bars", tickers, exc)
        for t, df in frames.items():
            if len(df) < MIN_BARS:  # too short for the indicators: let yfinance try, else "no data"
                continue
            q = quotes.get(t, {})
            data[t] = {
                "df": df,
                "price": q.get("price") or float(df["Close"].iloc[-1]),
                "prev_close": q.get("prev_close") or float(df["Close"].iloc[-2]),
                "data_as_of": q.get("ts") or f"{df.index[-1]:%Y-%m-%d} (close)",
                "source": "alpaca",
            }
    else:
        log.warning("ALPACA_API_KEY/ALPACA_API_SECRET not set; every ticker falls back to yfinance")

    missing = [t for t in tickers if t not in data]
    if missing and data:
        alpaca_md.warn_fallback("daily bars", missing, "no Alpaca bars")
    for t in missing:  # local runs only: Yahoo blocks cloud IPs
        try:
            t_obj = yf.Ticker(t)
            df = t_obj.history(period=period)
            if df is None or len(df) < MIN_BARS:
                continue
            fi = t_obj.fast_info
            data[t] = {
                "df": df,
                "price": float(fi.last_price or df["Close"].iloc[-1]),
                "prev_close": float(fi.previous_close or df["Close"].iloc[-2]),
                "data_as_of": f"{df.index[-1]:%Y-%m-%d} (close)",
                "source": "yfinance",
            }
        except Exception as exc:  # yfinance raises assorted network/rate-limit errors
            log.warning("yfinance fallback failed for %s: %s", t, exc)
    return data
