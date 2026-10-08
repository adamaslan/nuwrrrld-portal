"""Followed-ticker selection, freezing and horizon scoring (Section 9.6). Pure functions."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

HORIZONS: dict[str, int] = {"1w": 5, "2w": 10, "1m": 21, "2m": 42, "3m": 63, "6m": 126, "12m": 252}
CALLS_PER_SIDE = 10


def select_calls(candidates: list[dict]) -> dict[str, list[dict]]:
    """candidates: {ticker, strength, dominant_strength, adx}. Top 10 positive -> bull, top 10 negative -> bear.

    Rank by signed strength; ties break on |dominant-timeframe strength|, then ADX, then ticker.
    Fewer than 10 on a side stays fewer - never pad with weak calls.
    """
    def key(c: dict):
        return (-abs(c["strength"]), -abs(c.get("dominant_strength") or 0), -(c.get("adx") or 0), c["ticker"])

    bulls = sorted((c for c in candidates if c["strength"] > 0), key=key)[:CALLS_PER_SIDE]
    bears = sorted((c for c in candidates if c["strength"] < 0), key=key)[:CALLS_PER_SIDE]
    return {"bull": bulls, "bear": bears}


def reasoning_sha256(reasoning_md: str, fired_indicators: object) -> str:
    import json
    blob = json.dumps({"r": reasoning_md, "f": fired_indicators}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


@dataclass(frozen=True)
class HorizonScore:
    status: str
    exit_price: float | None = None
    raw_return: float | None = None
    directional_return: float | None = None
    benchmark_return: float | None = None
    excess_return: float | None = None
    hit: bool | None = None
    invalidated_before_target: bool | None = None
    max_adverse_excursion: float | None = None
    max_favorable_excursion: float | None = None
    void_reason: str | None = None


def score_horizon(side: str, entry: float, closes: list[float], bench_entry: float | None,
                  bench_exit: float | None, invalidation: float | None) -> HorizonScore:
    """closes = adjusted closes from the session AFTER entry through target (inclusive)."""
    if not closes:
        return HorizonScore("void", void_reason="no price data through target")
    sign = 1.0 if side == "bull" else -1.0
    exit_price = closes[-1]
    raw = exit_price / entry - 1
    directional = sign * raw
    bench_dir = None
    if bench_entry and bench_exit:
        bench_dir = sign * (bench_exit / bench_entry - 1)
    path = [sign * (c / entry - 1) for c in closes]
    invalidated = None
    if invalidation is not None:
        invalidated = any((c <= invalidation) if side == "bull" else (c >= invalidation) for c in closes)
    return HorizonScore("scored", exit_price, raw, directional, bench_dir,
                        (directional - bench_dir) if bench_dir is not None else None, directional > 0,
                        invalidated, min(path + [0.0]), max(path + [0.0]))
