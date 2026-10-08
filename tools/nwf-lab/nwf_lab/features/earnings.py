"""earnings-watch: upcoming dates (calendar) and surprise history."""
from __future__ import annotations

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import MissingInputError
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok


@feature("earnings-watch", needs=("earnings", "earnings_calendar"))
def earnings_watch(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    if not bundle.earnings and not bundle.earnings_calendar:
        raise MissingInputError("no earnings data in bundle")
    upcoming = {r["symbol"]: r for r in bundle.earnings_calendar}
    data = {}
    for t in bundle.tickers:
        hist = bundle.earnings.get(t, [])
        surprises = [h["surprisePercent"] for h in hist if h.get("surprisePercent") is not None]
        data[t] = {
            "next": upcoming.get(t),
            "avg_surprise_pct": round(sum(surprises) / len(surprises), 2) if surprises else None,
            "beats": sum(1 for s in surprises if s > 0), "quarters": len(surprises),
        }
    return ok("earnings-watch", data, sources=["finnhub"])
