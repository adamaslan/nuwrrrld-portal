"""holdfold: HOLD / WATCH / FOLD verdict per ticker.

Not a port of a portal rule (the portal route proxies gcp3). Defined here as: technical score
adjusted by analyst consensus and beta, cut at the configured thresholds."""
from __future__ import annotations

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

ANALYST_WEIGHT = 20.0     # +-10 points at 100% buy / 100% sell
HIGH_BETA = 1.5
HIGH_BETA_PENALTY = 5.0


def analyst_buy_share(rows: list[dict]) -> float | None:
    if not rows:
        return None
    r = rows[0]
    total = sum(r.get(k, 0) for k in ("strongBuy", "buy", "hold", "sell", "strongSell"))
    return None if total == 0 else (r.get("strongBuy", 0) + r.get("buy", 0)) / total


@feature("holdfold", needs=("recommendations", "metrics"), depends_on=("analyze",))
def holdfold(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    out = {}
    for t, d in ctx.upstream["analyze"].data.items():
        score, reasons = float(d["ai_score"]), [f"technical score {d['ai_score']} ({d['direction']})"]
        share = analyst_buy_share(bundle.recommendations.get(t, []))
        if share is not None:
            score += (share - 0.5) * ANALYST_WEIGHT
            reasons.append(f"{share:.0%} of analysts at buy or better")
        beta = bundle.metrics.get(t, {}).get("beta")
        if beta is not None and beta > HIGH_BETA:
            score -= HIGH_BETA_PENALTY
            reasons.append(f"high beta {beta:.2f}")
        verdict = "HOLD" if score >= cfg.hold_score else "FOLD" if score < cfg.fold_score else "WATCH"
        out[t] = {"verdict": verdict, "score": round(score, 1), "reasons": reasons}
    return ok("holdfold", out, sources=["analyze", "finnhub"])
