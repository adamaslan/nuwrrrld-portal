"""Deterministic synthetic provider for tests and offline demos. Never claims to be a real vendor."""
from __future__ import annotations

import zlib
from datetime import date, timedelta

import numpy as np
import pandas as pd

from nwf_lab.data.providers import BAR_COLUMNS

FIXTURE_END = date(2026, 10, 2)
SECTORS = ("Technology", "Healthcare", "Financial Services", "Energy")


def _rng(symbol: str) -> np.random.Generator:
    return np.random.default_rng(zlib.crc32(symbol.encode()))


class FixtureProvider:
    name = "fixture"

    def daily_bars(self, symbols: list[str], days: int) -> dict[str, pd.DataFrame]:
        out = {}
        for sym in symbols:
            rng = _rng(sym)
            dates = pd.bdate_range(end=pd.Timestamp(FIXTURE_END), periods=days, name="date")
            rets = rng.normal(0.0005, 0.015, len(dates))
            close = 100 * np.exp(np.cumsum(rets))
            open_ = np.r_[close[0], close[:-1]] * (1 + rng.normal(0, 0.002, len(dates)))
            high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.004, len(dates))))
            low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.004, len(dates))))
            vol = rng.integers(1_000_000, 5_000_000, len(dates)).astype(float)
            df = pd.DataFrame(
                dict(open=open_, high=high, low=low, close=close, volume=vol), index=dates
            )[BAR_COLUMNS]
            df.attrs.update({"source": "fixture", "feed": "synthetic"})
            out[sym] = df
        return out

    def quotes(self, symbols: list[str]) -> dict[str, dict]:
        bars = self.daily_bars(symbols, 5)
        return {
            s: {
                "price": float(b.close.iloc[-1]), "prev_close": float(b.close.iloc[-2]),
                "change_pct": float((b.close.iloc[-1] / b.close.iloc[-2] - 1) * 100),
                "source": "fixture",
            }
            for s, b in bars.items()
        }

    def profile(self, symbol: str) -> dict:
        rng = _rng(symbol)
        return {
            "name": f"{symbol} Corp", "finnhubIndustry": SECTORS[int(rng.integers(len(SECTORS)))],
            "marketCapitalization": float(rng.integers(50_000, 3_000_000)), "country": "US",
        }

    def metrics(self, symbol: str) -> dict:
        rng = _rng(symbol)
        return {
            "beta": round(float(rng.uniform(0.7, 1.8)), 2),
            "peBasicExclExtraTTM": round(float(rng.uniform(10, 45)), 1),
            "52WeekHigh": 200.0, "52WeekLow": 80.0,
        }

    def recommendations(self, symbol: str) -> list[dict]:
        rng = _rng(symbol)
        return [{
            "period": "2026-10-01", "strongBuy": int(rng.integers(2, 15)),
            "buy": int(rng.integers(5, 20)), "hold": int(rng.integers(3, 15)),
            "sell": int(rng.integers(0, 4)), "strongSell": int(rng.integers(0, 2)),
        }]

    def earnings(self, symbol: str) -> list[dict]:
        rng = _rng(symbol)
        return [
            {"period": f"2026-0{q}-30", "actual": round(float(1 + rng.normal(0, 0.1)), 2),
             "estimate": 1.0, "surprisePercent": round(float(rng.normal(2, 5)), 2)}
            for q in (3, 6, 9)
        ]

    def earnings_calendar(self, start: str, end: str) -> list[dict]:
        return [{"symbol": "AAPL", "date": end, "epsEstimate": 1.5, "hour": "amc"}]

    def insider_transactions(self, symbol: str) -> list[dict]:
        rng = _rng(symbol)
        day = (FIXTURE_END - timedelta(days=10)).isoformat()
        return [
            {"name": "Insider A", "change": int(rng.integers(-5000, 5000)),
             "transactionDate": day, "transactionPrice": 100.0, "transactionCode": "S"},
            {"name": "Insider B", "change": int(rng.integers(100, 3000)),
             "transactionDate": day, "transactionPrice": 99.0, "transactionCode": "P"},
        ]

    def peers(self, symbol: str) -> list[str]:
        return [symbol, "PEER1", "PEER2"]

    def company_news(self, symbol: str, start: str, end: str) -> list[dict]:
        return [
            {"headline": f"{symbol} beats earnings estimates, raises guidance", "datetime": 1,
             "source": "fixture", "url": ""},
            {"headline": f"{symbol} faces lawsuit and regulatory probe", "datetime": 2,
             "source": "fixture", "url": ""},
            {"headline": f"{symbol} announces new product line", "datetime": 3,
             "source": "fixture", "url": ""},
        ]
