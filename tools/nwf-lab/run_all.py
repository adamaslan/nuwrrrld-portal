#!/usr/bin/env python
"""Run every nwf-lab feature from one command.

  python run_all.py --tickers AAPL,NVDA,MSFT --portfolio fixtures/positions.csv
  python run_all.py --from-bundle runs/2026-10-07/bundle.parquet     # offline replay, 0 API calls
  python run_all.py --fixture                                        # synthetic data, no keys
  python run_all.py --probe                                          # Finnhub free/premium check
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from datetime import date, timedelta
from pathlib import Path

from nwf_lab.config import DEFAULT_TICKERS, Credentials, LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import LabError
from nwf_lab.features.llm import openrouter_caller
from nwf_lab.features.registry import run_features
from nwf_lab.pipeline import fetch_fixture, fetch_live, load_positions, load_tickers
from nwf_lab.report import exit_code, summary_line, write_run

DEFAULT_DAYS = 365
PROBE_PAUSE_S = 1.1


def probe() -> int:
    import httpx

    creds = Credentials.from_env()
    if not creds.finnhub:
        print("FINNHUB_API_KEY not set", file=sys.stderr)
        return 1
    today, d7, d14, d30 = date.today(), date.today() - timedelta(days=7), date.today() + timedelta(days=14), date.today() - timedelta(days=30)
    ts = lambda d: int(time.mktime(d.timetuple()))  # noqa: E731
    paths = [
        ("quote", {"symbol": "AAPL"}), ("stock/profile2", {"symbol": "AAPL"}),
        ("stock/metric", {"symbol": "AAPL", "metric": "all"}), ("stock/recommendation", {"symbol": "AAPL"}),
        ("stock/earnings", {"symbol": "AAPL"}), ("calendar/earnings", {"from": str(today), "to": str(d14)}),
        ("stock/insider-transactions", {"symbol": "AAPL"}), ("stock/peers", {"symbol": "AAPL"}),
        ("company-news", {"symbol": "AAPL", "from": str(d7), "to": str(today)}),
        ("stock/candle", {"symbol": "AAPL", "resolution": "D", "from": ts(d30), "to": ts(today)}),
        ("news-sentiment", {"symbol": "AAPL"}), ("stock/price-target", {"symbol": "AAPL"}),
    ]
    with httpx.Client(timeout=15.0, headers={"X-Finnhub-Token": creds.finnhub}) as c:
        for path, params in paths:
            code = c.get(f"https://finnhub.io/api/v1/{path}", params=params).status_code
            print(f"{code}  {path}")
            time.sleep(PROBE_PAUSE_S)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tickers", default=",".join(DEFAULT_TICKERS), help="comma-separated, or a path to a .csv")
    ap.add_argument("--tickers-file", help="CSV with a 'ticker' column (overrides --tickers)")
    ap.add_argument("--portfolio", help="positions CSV: symbol,shares,cost_basis")
    ap.add_argument("--days", type=int, default=DEFAULT_DAYS)
    ap.add_argument("--out", default="runs/")
    ap.add_argument("--from-bundle")
    ap.add_argument("--fixture", action="store_true", help="synthetic data; no keys, no network")
    ap.add_argument("--only", help="comma-separated feature slugs")
    ap.add_argument("--with-llm", action="store_true")
    ap.add_argument("--probe", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")

    if args.probe:
        return probe()
    cfg = LabConfig()
    try:
        if args.from_bundle:
            bundle = DataBundle.load(args.from_bundle)
            out_dir = Path(args.out)
        else:
            if args.tickers_file or args.tickers.lower().endswith(".csv"):
                tickers = load_tickers(args.tickers_file or args.tickers)
            else:
                tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
            positions = load_positions(args.portfolio)
            fetch = fetch_fixture if args.fixture else fetch_live
            if not args.fixture:
                print(f"{len(tickers)} tickers: a cold live run makes ~{9 * len(tickers)} Finnhub calls "
                      f"(~{9 * len(tickers) // 60} min at 1 req/s); warm cache is near-instant")
            bundle = fetch(tickers, args.days, cfg, positions)
            out_dir = Path(args.out) / date.today().isoformat()
        llm_call = None
        if args.with_llm:
            key = Credentials.from_env().openrouter
            if not key:
                raise LabError("--with-llm needs OPENROUTER_API_KEY")
            llm_call = openrouter_caller(key)
        only = [s.strip() for s in args.only.split(",")] if args.only else None
        results = run_features(bundle, cfg, with_llm=args.with_llm, only=only, llm_call=llm_call)
    except LabError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    write_run(out_dir, bundle, results)
    for g in bundle.gaps:
        print(f"GAP  {g}")
    print(summary_line(results))
    print(f"wrote {out_dir}/")
    return exit_code(results)


if __name__ == "__main__":
    sys.exit(main())
