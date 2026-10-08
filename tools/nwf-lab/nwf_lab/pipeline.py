"""Wiring shared by the CLI, Streamlit and the notebook: build providers, fetch a bundle."""
from __future__ import annotations

import os
from pathlib import Path

import httpx
import pandas as pd

from nwf_lab.config import Credentials, LabConfig
from nwf_lab.data.alpaca import AlpacaBarsProvider
from nwf_lab.data.bundle import DataBundle, fetch_bundle
from nwf_lab.data.cache import ResponseCache
from nwf_lab.data.finnhub import FinnhubProvider
from nwf_lab.data.fixture import FixtureProvider
from nwf_lab.data.yfinance_local import YFinanceLocalProvider
from nwf_lab.errors import LabError


def load_positions(path: str | Path | None) -> pd.DataFrame | None:
    if not path:
        return None
    df = pd.read_csv(path)
    missing = {"symbol", "shares"} - set(df.columns)
    if missing:
        raise LabError(f"positions CSV missing columns: {', '.join(sorted(missing))}")
    return df


def fetch_live(tickers: list[str], days: int, cfg: LabConfig, positions: pd.DataFrame | None = None,
               creds: Credentials | None = None) -> DataBundle:
    creds = creds or Credentials.from_env()
    if not creds.finnhub:
        raise LabError("FINNHUB_API_KEY not set (checked env and .env.local)")
    cache = ResponseCache()
    finnhub = FinnhubProvider(creds.finnhub, cache, httpx.Client(timeout=15.0))
    mode = os.getenv("NWF_LAB_BARS", "alpaca").lower()
    chain: list = []
    if mode == "finnhub":
        chain = [finnhub]                      # every bar-dependent feature will report vendor_gap
    else:
        if creds.alpaca_key and creds.alpaca_secret:
            chain.append(AlpacaBarsProvider(creds.alpaca_key, creds.alpaca_secret))
        chain.append(YFinanceLocalProvider())   # laptop only
    bundle = fetch_bundle(tickers, days, cfg, bars_providers=chain, quote_provider=finnhub,
                          fundamentals=finnhub, positions=positions)
    bundle.provenance["_api_calls"] = sum(getattr(p, "api_calls", 0) for p in [finnhub, *chain])
    return bundle


def fetch_fixture(tickers: list[str], days: int, cfg: LabConfig,
                  positions: pd.DataFrame | None = None) -> DataBundle:
    fx = FixtureProvider()
    return fetch_bundle(tickers, days, cfg, bars_providers=[fx], quote_provider=fx,
                        fundamentals=fx, positions=positions)
