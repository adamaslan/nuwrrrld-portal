"""EOD bar ingestion with fail-closed validation (Sections 12, 16)."""
from __future__ import annotations

import dataclasses
import datetime as dt
import logging
import time
from decimal import Decimal
from pathlib import Path
from typing import Callable

import pandas as pd

from nuwrrrld import dynamo
from nuwrrrld.calendar import today_et
from nuwrrrld.jobs import universe
from nuwrrrld.jobs.runner import run_job
from nuwrrrld.providers import daily_bars_with_fallback
from nuwrrrld.providers.base import Bar, DataNotReady, MarketDataProvider

log = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 300
MAX_POLLS = 12                    # 60 minutes
MAX_DAILY_MOVE = Decimal("0.25")
MAX_FAILED_VALIDATION = 2
GAP_HEAL_DAYS = 10


class IngestFailed(Exception):
    pass


def validate_bars(bars: list[Bar], prev_close: dict[str, Decimal], split_tickers: set[str]) -> tuple[list[Bar], list[tuple[str, str]]]:
    """(good, bad[(ticker, reason)]). Flags OHLC insanity and >25% moves not explained by a corporate action."""
    good, bad = [], []
    for b in bars:
        if b.low <= 0 or b.high < max(b.open, b.close) or b.low > min(b.open, b.close) or b.volume < 0:
            bad.append((b.ticker, f"ohlc sanity {b.bar_date}"))
            continue
        prev = prev_close.get(b.ticker)
        if prev and prev > 0 and abs(b.close / prev - 1) > MAX_DAILY_MOVE and b.ticker not in split_tickers:
            bad.append((b.ticker, f"move {b.close / prev - 1:+.1%} without corporate action {b.bar_date}"))
            continue
        good.append(b)
    return good, bad


UPSERT_BAR = """
INSERT INTO price_bars (ticker, timeframe, bar_date, open, high, low, close, volume, vwap, adj_close, adj_factor, provider, is_final)
VALUES (%s,'1d',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
ON CONFLICT (ticker, timeframe, bar_date) DO UPDATE SET
  open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, volume=EXCLUDED.volume,
  vwap=EXCLUDED.vwap, adj_close=EXCLUDED.adj_close, adj_factor=EXCLUDED.adj_factor, provider=EXCLUDED.provider,
  is_final=EXCLUDED.is_final, ingested_at=now()"""


def upsert_bars(conn, bars: list[Bar]) -> int:
    with conn.cursor() as cur:
        cur.executemany(UPSERT_BAR, [(b.ticker, b.bar_date, b.open, b.high, b.low, b.close, b.volume, b.vwap,
                                      b.adj_close, b.adj_factor, f"{b.provider}:{b.feed}" if b.feed else b.provider,
                                      b.is_final) for b in bars])
    dynamo.mirror_rows("price_bars", [{**dataclasses.asdict(b), "timeframe": "1d"} for b in bars])
    return len(bars)


def write_parquet(cache_dir: str, bars: list[Bar]) -> None:
    root = Path(cache_dir) / "bars" / "1d"
    root.mkdir(parents=True, exist_ok=True)
    by_ticker: dict[str, list[Bar]] = {}
    for b in bars:
        by_ticker.setdefault(b.ticker, []).append(b)
    for ticker, rows in by_ticker.items():            # one writer per ticker file
        path = root / f"{ticker}.parquet"
        new = pd.DataFrame([{k: float(v) if isinstance(v, Decimal) else v for k, v in dataclasses.asdict(b).items()}
                            for b in rows])
        if path.exists():
            new = pd.concat([pd.read_parquet(path), new]).drop_duplicates("bar_date", keep="last")
        new.sort_values("bar_date").to_parquet(path, index=False)


def upsert_corporate_actions(conn, actions) -> None:
    rows = [{"ticker": a.ticker, "ex_date": a.ex_date, "kind": a.kind, "ratio": a.ratio, "amount": a.amount,
             "provider": "alpaca"} for a in actions]
    with conn.cursor() as cur:
        cur.executemany(
            """INSERT INTO corporate_actions (ticker, ex_date, kind, ratio, amount, provider)
               VALUES (%(ticker)s,%(ex_date)s,%(kind)s,%(ratio)s,%(amount)s,%(provider)s)
               ON CONFLICT (ticker, ex_date, kind) DO NOTHING""", rows)


def _previous_closes(conn, tickers: list[str], before: dt.date) -> dict[str, Decimal]:
    rows = conn.execute("SELECT DISTINCT ON (ticker) ticker, close FROM price_bars WHERE ticker = ANY(%s) AND bar_date < %s "
                        "ORDER BY ticker, bar_date DESC", (tickers, before)).fetchall()
    return {r["ticker"]: r["close"] for r in rows}


def ingest_eod(conn, provider: MarketDataProvider, fallback: MarketDataProvider | None, *, cache_dir: str | None = None,
               now: dt.datetime | None = None, sleep: Callable[[float], None] | None = None,
               max_polls: int = MAX_POLLS, force: bool = False) -> dict:
    """Ingest the latest session. Fails closed: if a tracked ETF is missing, or >2 fail validation, the job
    is recorded failed, signals do not publish, and the watchdog alerts."""
    sleep = sleep or time.sleep
    cal = universe.calendar_for(conn)
    today = today_et(now)
    session = cal.session_for(today)
    with run_job(conn, "ingest_eod_bars", (session or today).isoformat(), force=force) as ctx:
        if ctx is None:
            return {"status": "not_claimed"}
        if session is None:
            ctx.skip("market closed")
            return {"status": "skipped"}
        tracked = universe.tracked_tickers(conn)
        everything = sorted(set(tracked) | set(universe.benchmark_tickers(conn)))
        start = session - dt.timedelta(days=GAP_HEAL_DAYS)
        bars, missing = [], list(tracked)
        for attempt in range(max_polls):
            bars, missing_all = daily_bars_with_fallback(provider, everything, start, session, fallback)
            todays = {b.ticker for b in bars if b.bar_date == session}
            missing = [t for t in tracked if t not in todays]
            if not missing:
                break
            ctx.heartbeat()
            log.warning("ingest: %d tracked tickers missing for %s (poll %d/%d)", len(missing), session, attempt + 1, max_polls)
            if attempt < max_polls - 1:
                sleep(POLL_INTERVAL_SECONDS)
        if missing:
            raise IngestFailed(f"tracked ETFs missing for {session}: {missing}")
        actions = provider.corporate_actions(everything, start, session)
        upsert_corporate_actions(conn, actions)
        split_tickers = {a.ticker for a in actions if a.kind == "split" and a.ex_date >= start}
        prev = _previous_closes(conn, everything, session)
        good, bad = validate_bars([b for b in bars if b.bar_date == session], prev, split_tickers)
        bad_tracked = [t for t, _ in bad if t in tracked]
        if len(bad_tracked) > MAX_FAILED_VALIDATION:
            raise IngestFailed(f"{len(bad_tracked)} tracked ETFs failed validation: {bad}")
        if bad_tracked:
            raise IngestFailed(f"validation failed for tracked ETFs (fail closed): {bad}")
        history = [b for b in bars if b.bar_date != session]
        n = upsert_bars(conn, history + good)
        if cache_dir:
            write_parquet(cache_dir, history + good)
        ctx.detail.update({"bars": n, "session": session.isoformat(), "flagged": bad})
        return {"status": "succeeded", "bars": n, "flagged": bad}


def backfill_ticker(conn, provider: MarketDataProvider, fallback: MarketDataProvider | None, ticker: str,
                    start: str, end: str, cache_dir: str | None = None) -> int:
    """Upsert history for one ticker from ONE vendor (never splice vendors for a ticker's window)."""
    s, e = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    bars, missing = daily_bars_with_fallback(provider, [ticker], s, e, fallback)
    if missing:
        log.warning("backfill: no data for %s", ticker)
        return 0
    n = upsert_bars(conn, bars)
    if cache_dir:
        write_parquet(cache_dir, bars)
    return n
