"""analyze: indicators + direction/confidence voting, mirroring homebase/locrun.py:analyze()."""
from __future__ import annotations

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import VendorGapError
from nwf_lab.features.indicators import MIN_BARS, action_of, direction_of, indicator_frame, votes
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok


def analyze_symbol(symbol: str, df, quote: dict | None, cfg: LabConfig) -> tuple[dict, object]:
    """Pure core, also used by the parity test. Returns (locrun-shaped dict, indicator frame)."""
    frame = indicator_frame(df, cfg)
    price = float(quote["price"]) if quote and quote.get("price") else float(df["close"].iloc[-1])
    prev_close = (
        float(quote["prev_close"]) if quote and quote.get("prev_close") else float(df["close"].iloc[-2])
    )
    last = frame.iloc[-1].copy()
    last["price_vs_sma"] = (price - last["sma_fast"]) / last["sma_fast"]
    live = frame.iloc[[-1]].copy()
    live.iloc[0] = last
    bull_s, bear_s = votes(live, cfg)
    bull, bear = int(bull_s.iloc[0]), int(bear_s.iloc[0])

    rsi, hist, vol_ratio = last["rsi"], last["macd_hist"], last["vol_ratio"]
    pvs = last["price_vs_sma"]
    direction = direction_of(bull, bear, cfg)
    score = round(50 + (bull - bear) * 12.5)
    spread = abs(bull - bear)
    confidence = "high" if spread >= 3 else "medium" if spread >= 2 else "low"

    signals: list[dict] = []
    if rsi > 60:
        signals.append({"signal": f"RSI {rsi:.0f} — momentum bullish", "strength": "BULLISH", "category": "momentum"})
    if rsi < 40:
        signals.append({"signal": f"RSI {rsi:.0f} — oversold", "strength": "BEARISH", "category": "momentum"})
    if rsi > cfg.rsi_overbought:
        signals.append({"signal": f"RSI {rsi:.0f} — overbought", "strength": "BEARISH", "category": "momentum"})
    if hist > 0:
        signals.append({"signal": "MACD histogram positive", "strength": "BULLISH", "category": "trend"})
    if hist < 0:
        signals.append({"signal": "MACD histogram negative", "strength": "BEARISH", "category": "trend"})
    if vol_ratio > 1.3:
        signals.append({"signal": f"Volume surge {vol_ratio:.1f}x", "strength": "BULLISH", "category": "volume"})

    band = last["bb_upper"] - last["bb_lower"]
    bb_pct = (price - last["bb_lower"]) / band if band > 0 else 0.5
    action = action_of(score, cfg)
    result = {
        "ticker": symbol, "symbol": symbol, "direction": direction, "confidence": confidence,
        "price": round(price, 2), "prev_close": round(prev_close, 2),
        "change_pct": round((price - prev_close) / prev_close * 100, 2) if prev_close else 0.0,
        "signal_count": len(signals), "signals": signals,
        "ai_score": score, "ai_action": action,
        "ai_outlook": "BULLISH" if score >= cfg.buy_score else "BEARISH" if score <= cfg.sell_score else "NEUTRAL",
        "ai_confidence": confidence.upper(),
        "ai_summary": f"{symbol} {action} — RSI {rsi:.0f}, MACD {hist:+.2f}, vol {vol_ratio:.1f}x",
        "explanation": (
            f"RSI at {rsi:.1f} ({'overbought' if rsi > cfg.rsi_overbought else 'oversold' if rsi < cfg.rsi_oversold else 'neutral'}). "
            f"MACD histogram {hist:+.3f}. Price {abs(pvs) * 100:.1f}% {'above' if pvs > 0 else 'below'} "
            f"{cfg.sma_fast}-day SMA. Volume {vol_ratio:.1f}x average."
        ),
        "indicators_raw": {
            "rsi": round(float(rsi), 2), "macd": round(float(last["macd"]), 4),
            "macd_signal": round(float(last["macd_signal"]), 4), "macd_hist": round(float(hist), 4),
            "bb_upper": round(float(last["bb_upper"]), 2), "bb_lower": round(float(last["bb_lower"]), 2),
            "bb_mid": round(float(last["bb_mid"]), 2), "bb_pct": round(float(bb_pct), 3),
            "sma20": round(float(last["sma_fast"]), 2), "sma50": round(float(last["sma_slow"]), 2),
            "ema20": round(float(last["ema20"]), 2), "volume_ratio": round(float(vol_ratio), 2),
        },
        "bull_votes": bull, "bear_votes": bear,
    }
    return result, frame


@feature("analyze", needs=("bars",))
def analyze(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    if not bundle.bars:
        raise VendorGapError("bars", "daily", None)
    data, frames, skipped, sources = {}, {}, [], set()
    for sym in bundle.tickers:
        df = bundle.bars.get(sym)
        if df is None or len(df) < MIN_BARS:
            skipped.append(sym)
            continue
        data[sym], frames[sym] = analyze_symbol(sym, df, bundle.quotes.get(sym), cfg)
        sources.add(f"{df.attrs.get('source', '?')}:{df.attrs.get('feed', '?')}")
    note = f"skipped (<{MIN_BARS} bars or missing): {', '.join(skipped)}" if skipped else None
    if not data:
        raise VendorGapError("bars", "daily", None)
    return ok("analyze", data, frames, sorted(sources), note)
