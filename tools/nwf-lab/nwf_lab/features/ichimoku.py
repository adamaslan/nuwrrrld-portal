"""ichimoku: Tenkan/Kijun/cloud/Chikou signals. The cloud at date t is the span computed
`kijun` bars earlier, which is how the chart draws it."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import VendorGapError
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

STRONG_SCORE = 3


def ichimoku_frame(df: pd.DataFrame, cfg: LabConfig) -> pd.DataFrame:
    def mid(n: int) -> pd.Series:
        return (df["high"].rolling(n).max() + df["low"].rolling(n).min()) / 2

    out = pd.DataFrame(index=df.index)
    out["close"] = df["close"]
    out["tenkan"], out["kijun"] = mid(cfg.ichi_tenkan), mid(cfg.ichi_kijun)
    out["span_a"] = ((out["tenkan"] + out["kijun"]) / 2).shift(cfg.ichi_kijun)
    out["span_b"] = mid(cfg.ichi_senkou_b).shift(cfg.ichi_kijun)
    out["cloud_top"] = out[["span_a", "span_b"]].max(axis=1, skipna=False)
    out["cloud_bottom"] = out[["span_a", "span_b"]].min(axis=1, skipna=False)
    out["close_26_ago"] = df["close"].shift(cfg.ichi_kijun)   # Chikou compares today's close to this
    return out


def ichimoku_symbol(df: pd.DataFrame, cfg: LabConfig) -> tuple[dict, pd.DataFrame]:
    fr = ichimoku_frame(df, cfg)
    last = fr.iloc[-1]
    price = float(last["close"])
    position = 1 if price > last["cloud_top"] else -1 if price < last["cloud_bottom"] else 0
    tk = 1 if last["tenkan"] > last["kijun"] else -1
    color = 1 if last["span_a"] > last["span_b"] else -1
    chikou = 1 if price > last["close_26_ago"] else -1
    score = position + tk + color + chikou

    diff = (fr["tenkan"] - fr["kijun"]).dropna()
    cross = None
    recent = diff.iloc[-(cfg.ichi_cross_lookback + 1):]
    if len(recent) > 1 and (recent.iloc[0] <= 0) != (recent.iloc[-1] <= 0):
        cross = "bullish" if recent.iloc[-1] > 0 else "bearish"

    bias = ("strong_bullish" if score >= STRONG_SCORE else "bullish" if score > 0 else
            "strong_bearish" if score <= -STRONG_SCORE else "bearish" if score < 0 else "neutral")
    reasons = [
        f"price {'above' if position > 0 else 'below' if position < 0 else 'inside'} the cloud",
        f"Tenkan {'above' if tk > 0 else 'below'} Kijun",
        f"cloud is {'bullish (A over B)' if color > 0 else 'bearish (B over A)'}",
        f"Chikou {'above' if chikou > 0 else 'below'} price {cfg.ichi_kijun} bars ago",
    ]
    if cross:
        reasons.append(f"{cross} Tenkan/Kijun cross within {cfg.ichi_cross_lookback} bars")
    return {
        "bias": bias, "score": int(score), "price": round(price, 2), "reasons": reasons,
        "cloud_top": round(float(last["cloud_top"]), 2), "cloud_bottom": round(float(last["cloud_bottom"]), 2),
        "tenkan": round(float(last["tenkan"]), 2), "kijun": round(float(last["kijun"]), 2),
        "recent_cross": cross,
    }, fr


@feature("ichimoku", needs=("bars",))
def ichimoku(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    need = cfg.ichi_senkou_b + cfg.ichi_kijun + 1
    data, frames, skipped = {}, {}, []
    for sym, df in bundle.bars.items():
        if len(df) < need:
            skipped.append(sym)
            continue
        data[sym], frames[sym] = ichimoku_symbol(df, cfg)
    if not data:
        raise VendorGapError("bars", f"daily (need {need}+ bars)", None)
    note = f"skipped (<{need} bars): {', '.join(skipped)}" if skipped else None
    return ok("ichimoku", data, frames, ["bars"], note)
