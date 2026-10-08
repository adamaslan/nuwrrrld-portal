"""portfolio-health, portfolio-suggestions, followed-tickers-read."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import MissingInputError
from nwf_lab.features.indicators import indicator_frame, score_series
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

MAX_SINGLE_WEIGHT = 0.20
MAX_SECTOR_WEIGHT = 0.50
CONCENTRATION_PENALTY = 40.0   # points lost at HHI == 1 (single position)
SINGLE_PENALTY = 20.0
SECTOR_PENALTY = 20.0
BETA_PENALTY = 15.0
HIGH_PORTFOLIO_BETA = 1.3


def _price(bundle: DataBundle, sym: str) -> float | None:
    q = bundle.quotes.get(sym)
    if q and q.get("price"):
        return float(q["price"])
    b = bundle.bars.get(sym)
    return None if b is None or b.empty else float(b["close"].iloc[-1])


def _positions_table(bundle: DataBundle) -> pd.DataFrame:
    if bundle.positions is None or bundle.positions.empty:
        raise MissingInputError("no positions CSV provided (symbol,shares,cost_basis)")
    rows = []
    for r in bundle.positions.to_dict("records"):
        sym = str(r["symbol"]).upper().replace("-", ".")
        px = _price(bundle, sym)
        if px is None:
            continue
        value = float(r["shares"]) * px
        rows.append({
            "symbol": sym, "shares": float(r["shares"]), "price": px, "value": value,
            "cost_basis": float(r.get("cost_basis") or 0),
            "sector": bundle.profiles.get(sym, {}).get("finnhubIndustry", "Unknown"),
            "beta": bundle.metrics.get(sym, {}).get("beta"),
        })
    if not rows:
        raise MissingInputError("no position has a price in the bundle")
    df = pd.DataFrame(rows)
    df["weight"] = df["value"] / df["value"].sum()
    return df


@feature("portfolio-health", needs=("positions", "quotes", "profiles", "metrics"))
def portfolio_health(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    df = _positions_table(bundle)
    hhi = float((df["weight"] ** 2).sum())
    sectors = df.groupby("sector")["weight"].sum().sort_values(ascending=False)
    betas = df.dropna(subset=["beta"])
    beta = float((betas["weight"] * betas["beta"]).sum() / betas["weight"].sum()) if len(betas) else None
    score, flags = 100.0, []
    score -= CONCENTRATION_PENALTY * hhi
    if df["weight"].max() > MAX_SINGLE_WEIGHT:
        score -= SINGLE_PENALTY
        top = df.loc[df["weight"].idxmax()]
        flags.append(f"{top['symbol']} is {top['weight']:.0%} of the portfolio")
    if sectors.iloc[0] > MAX_SECTOR_WEIGHT:
        score -= SECTOR_PENALTY
        flags.append(f"{sectors.index[0]} is {sectors.iloc[0]:.0%} of the portfolio")
    if beta is not None and beta > HIGH_PORTFOLIO_BETA:
        score -= BETA_PENALTY
        flags.append(f"weighted beta {beta:.2f}")
    cost = (df["shares"] * df["cost_basis"]).sum()
    return ok("portfolio-health", {
        "score": round(max(score, 0.0), 1), "total_value": round(float(df["value"].sum()), 2),
        "hhi": round(hhi, 4), "weighted_beta": None if beta is None else round(beta, 2),
        "sector_weights": {k: round(float(v), 4) for k, v in sectors.items()},
        "unrealized_pnl": round(float(df["value"].sum() - cost), 2) if cost else None,
        "flags": flags,
    }, {"positions": df}, ["quotes", "finnhub"])


@feature("portfolio-suggestions", depends_on=("portfolio-health", "holdfold"))
def portfolio_suggestions(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    df = ctx.upstream["portfolio-health"].frames["positions"]
    verdicts = ctx.upstream["holdfold"].data
    out = []
    for r in df.itertuples():
        if r.weight > MAX_SINGLE_WEIGHT:
            out.append({"action": "trim", "symbol": r.symbol,
                        "why": f"{r.weight:.0%} of portfolio exceeds the {MAX_SINGLE_WEIGHT:.0%} single-name cap"})
        if verdicts.get(r.symbol, {}).get("verdict") == "FOLD":
            held = set(df["symbol"])
            alts = [p for p in bundle.peers.get(r.symbol, []) if p != r.symbol and p not in held][:3]
            out.append({"action": "swap" if alts else "review", "symbol": r.symbol,
                        "why": "holdfold verdict FOLD", "alternatives": alts})
    sector = ctx.upstream["portfolio-health"].data["sector_weights"]
    for name, w in sector.items():
        if w > MAX_SECTOR_WEIGHT:
            out.append({"action": "diversify", "symbol": None,
                        "why": f"{name} is {w:.0%} of the portfolio (cap {MAX_SECTOR_WEIGHT:.0%})"})
    return ok("portfolio-suggestions", {"suggestions": out})


@feature("followed-tickers-read", depends_on=("analyze",))
def followed_tickers_read(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    """Scoreboard: what did the rule say `backtest_hold_days` bars ago, and what happened since?"""
    hold = cfg.backtest_hold_days
    rows = []
    for sym, df in bundle.bars.items():
        if len(df) < cfg.backtest_min_bars + hold:
            continue
        score = float(score_series(indicator_frame(df, cfg), cfg).iloc[-hold - 1])
        realized = float(df["close"].iloc[-1] / df["close"].iloc[-hold - 1] - 1)
        call = "BUY" if score >= cfg.buy_score else "SELL" if score <= cfg.sell_score else "HOLD"
        verdict = ("right" if (call == "BUY" and realized > 0) or (call == "SELL" and realized < 0)
                   else "n/a" if call == "HOLD" else "wrong")
        rows.append({"ticker": sym, "past_call": call, "past_score": score,
                     "realized_return": round(realized, 4), "outcome": verdict})
    df = pd.DataFrame(rows)
    scored = df[df["outcome"] != "n/a"] if not df.empty else df
    hit = None if scored.empty else round(float((scored["outcome"] == "right").mean()), 3)
    return ok("followed-tickers-read", {"rows": rows, "hit_rate": hit, "lookback_bars": hold},
              {"scoreboard": df})
