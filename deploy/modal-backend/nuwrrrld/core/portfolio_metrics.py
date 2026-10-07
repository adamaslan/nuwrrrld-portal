"""Deterministic Portfolio Intel metrics + rule-based findings (Section 9.5)."""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict

HHI_HIGH, TOP5_HIGH, SECTOR_OVERWEIGHT, BETA_HIGH, BEARISH_OVERLAP = 0.25, 0.80, 0.40, 1.3, 0.30


def holdings_hash(holdings: list[dict]) -> str:
    norm = sorted((h["ticker"], h.get("account_label", "default"), float(h["quantity"])) for h in holdings)
    return hashlib.sha256(json.dumps(norm).encode()).hexdigest()[:32]


def compute_metrics(positions: list[dict]) -> dict:
    """positions: {ticker, quantity, close, sector, beta, vol_63, signal_direction, verdict, inval}."""
    values = {p["ticker"]: abs(p["quantity"]) * p["close"] for p in positions if p.get("close")}
    total = sum(values.values())
    if total <= 0:
        return {"total_value": 0.0, "weights": {}, "unmapped": [p["ticker"] for p in positions]}
    weights = {t: v / total for t, v in values.items()}
    sector: dict[str, float] = defaultdict(float)
    for p in positions:
        if p["ticker"] in weights:
            sector[p.get("sector") or "unmapped"] += weights[p["ticker"]]
    mapped = [p for p in positions if p.get("beta") is not None and p["ticker"] in weights]
    beta = sum(weights[p["ticker"]] * p["beta"] for p in mapped) if mapped else None
    vol = sum(weights[p["ticker"]] * p["vol_63"] for p in positions if p.get("vol_63") is not None and p["ticker"] in weights)
    bearish = sum(weights[p["ticker"]] for p in positions if p.get("signal_direction") == "bearish" and p["ticker"] in weights)
    top5 = sum(sorted(weights.values(), reverse=True)[:5])
    return {"total_value": round(total, 2), "weights": {t: round(w, 6) for t, w in weights.items()},
            "hhi": round(sum(w * w for w in weights.values()), 6), "top5_weight": round(top5, 6),
            "sector_exposure": {k: round(v, 6) for k, v in sector.items()},
            "beta_spy_252": round(beta, 4) if beta is not None else None, "vol_63": round(vol, 6),
            "bearish_weight": round(bearish, 6),
            "fold_count": sum(1 for p in positions if p.get("verdict") == "fold"),
            "unmapped": [p["ticker"] for p in positions if p.get("beta") is None]}


def findings(metrics: dict) -> list[dict]:
    out: list[dict] = []
    if not metrics.get("weights"):
        return out
    if metrics["hhi"] >= HHI_HIGH:
        out.append({"severity": "high", "code": "CONCENTRATION_HIGH",
                    "message": f"Concentration index {metrics['hhi']:.2f} is at or above {HHI_HIGH}.",
                    "evidence_refs": ["hhi", "top5_weight"]})
    for sector_name, w in metrics["sector_exposure"].items():
        if w >= SECTOR_OVERWEIGHT and sector_name != "unmapped":
            out.append({"severity": "medium", "code": "SECTOR_OVERWEIGHT",
                        "message": f"{sector_name} is {w:.0%} of the portfolio.", "evidence_refs": [f"sector_exposure.{sector_name}"]})
    if metrics.get("beta_spy_252") is not None and metrics["beta_spy_252"] >= BETA_HIGH:
        out.append({"severity": "medium", "code": "HIGH_BETA",
                    "message": f"Portfolio beta vs. SPY is {metrics['beta_spy_252']:.2f}.", "evidence_refs": ["beta_spy_252"]})
    if metrics["bearish_weight"] >= BEARISH_OVERLAP:
        out.append({"severity": "medium", "code": "BEARISH_OVERLAP",
                    "message": f"{metrics['bearish_weight']:.0%} of weight sits in tickers with bearish signals.",
                    "evidence_refs": ["bearish_weight"]})
    return out
