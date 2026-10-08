"""signals-live / signals-top / signals-digest / signals-card, all derived from analyze."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

CONF_RANK = {"HIGH": 2, "MEDIUM": 1, "LOW": 0}


@feature("signals-live", depends_on=("analyze",))
def signals_live(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    a = ctx.upstream["analyze"].data
    rows = [
        {"ticker": t, **s} for t, d in a.items() for s in d["signals"]
    ]
    return ok("signals-live", {"signals": rows, "count": len(rows)},
              {"signals": pd.DataFrame(rows)}, ctx.upstream["analyze"].sources)


@feature("signals-top", depends_on=("analyze",))
def signals_top(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    a = ctx.upstream["analyze"].data
    df = pd.DataFrame([
        {"ticker": t, "ai_score": d["ai_score"], "ai_action": d["ai_action"],
         "direction": d["direction"], "confidence": d["ai_confidence"],
         "change_pct": d["change_pct"], "price": d["price"],
         "_c": CONF_RANK[d["ai_confidence"]]}
        for t, d in a.items()
    ])
    ranked = df.sort_values(["ai_score", "_c", "change_pct"], ascending=False).drop(columns="_c")
    ranked = ranked.head(cfg.top_n).reset_index(drop=True)
    ranked.index += 1
    return ok("signals-top", {"ranked": ranked.reset_index(names="rank").to_dict("records")},
              {"ranked": ranked}, ctx.upstream["analyze"].sources)


@feature("signals-digest", depends_on=("signals-top", "analyze"))
def signals_digest(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    top = ctx.upstream["signals-top"].data["ranked"]
    a = ctx.upstream["analyze"].data
    lines = [f"{len(a)} tickers analyzed; top {len(top)} by score:"]
    for r in top:
        lines.append(f"  {r['rank']}. {r['ticker']}: {r['ai_action']} ({r['ai_score']}, "
                     f"{r['direction']}, {r['confidence'].lower()} confidence, {r['change_pct']:+.2f}%)")
    heads = [h["headline"] for t in bundle.tickers[:3] for h in bundle.news.get(t, [])[:1]]
    if heads:
        lines.append("Headlines: " + " | ".join(heads))
    return ok("signals-digest", {"text": "\n".join(lines)})


@feature("signals-card", depends_on=("signals-top", "analyze"))
def signals_card(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    """Share-card JSON payload for the top ticker (no PNG rendering in the lab)."""
    top = ctx.upstream["signals-top"].data["ranked"][0]
    t = top["ticker"]
    d = ctx.upstream["analyze"].data[t]
    prof = bundle.profiles.get(t, {})
    return ok("signals-card", {
        "ticker": t, "name": prof.get("name", t), "headline": d["ai_summary"],
        "action": d["ai_action"], "score": d["ai_score"], "direction": d["direction"],
        "price": d["price"], "change_pct": d["change_pct"], "indicators": d["indicators_raw"],
    })
