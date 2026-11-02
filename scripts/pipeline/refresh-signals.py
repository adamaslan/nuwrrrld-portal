#!/usr/bin/env python3
"""
refresh-signals.py — manual local tool to pull fresh signal data via Alpaca (yfinance fallback)
and push the digest to Firestore + the NuWrrrld portal cache.

Usage:
    mamba activate fin-ai1
    python scripts/pipeline/refresh-signals.py [OPTIONS]

Options:
    --tickers AAPL MSFT NVDA   Override default universe (beta1)
    --universe beta1|sp500|nasdaq100|etf_sector
    --push                     Push digest to portal cache (requires PORTAL_URL)
    --firestore                Write results to Firestore (requires GCP creds)
    --dry-run                  Fetch and print only, no writes

Requirements (all in fin-ai1 mamba env):
    pandas, ta, requests, python-dotenv,
    yfinance (fallback only), finnhub-python and google-cloud-firestore (optional)

Env vars (loaded from .env / .env.local in mcp-finance1/):
    ALPACA_API_KEY / ALPACA_API_SECRET   Alpaca paper key pair (primary data)
    FINNHUB_API_KEY            Finnhub news only (optional)
    EXPO_PUBLIC_PORTAL_URL     Portal base URL (for --push)
    PORTAL_PUSH_SECRET         Bearer token for portal push endpoint
    GOOGLE_APPLICATION_CREDENTIALS  (for --firestore)
"""

from __future__ import annotations
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Load env from mcp-finance1 project
# scripts/pipeline/ -> repo root -> ~/code; mcp-finance1 is a sibling checkout of this repo
_ROOT = Path(__file__).resolve().parents[3] / "gcp-app-w-mcp1" / "mcp-finance1"

import logging

from market_data import MIN_BARS, PERIOD_CHOICES, PORTAL_ENV_FILE, load_market_data

try:
    from dotenv import load_dotenv
    load_dotenv(_ROOT / ".env")
    load_dotenv(_ROOT / ".env.local", override=False)
    # PORTAL_PUSH_SECRET and EXPO_PUBLIC_PORTAL_URL live in the portal env (or its primary checkout).
    load_dotenv(PORTAL_ENV_FILE, override=False)
except ImportError:
    pass

logging.basicConfig(level=logging.INFO, format="  %(levelname)s %(message)s")

try:
    import pandas as pd
except ImportError:
    sys.exit("pandas not installed")

# ---------------------------------------------------------------------------
# Universes
# ---------------------------------------------------------------------------
UNIVERSES: dict[str, list[str]] = {
    "beta1":   ["MU", "GLD", "NVDA", "RGTI", "PL", "GEV", "GOOG", "IBIT", "APLD"],
    "nasdaq100_top": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "COST", "NFLX"],
    "etf_sector": ["XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE"],
    "sp500_top": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "UNH"],
}

# ---------------------------------------------------------------------------
# Signal computation (Alpaca bars + simple indicators)
# ---------------------------------------------------------------------------

def _direction(rsi: float, macd_hist: float, price_vs_sma: float) -> str:
    bullish = sum([rsi > 55, macd_hist > 0, price_vs_sma > 0])
    bearish = sum([rsi < 45, macd_hist < 0, price_vs_sma < 0])
    if bullish >= 2: return "bullish"
    if bearish >= 2: return "bearish"
    return "neutral"


def _confidence(rsi: float, macd_hist: float, volume_ratio: float) -> str:
    score = 0
    if abs(rsi - 50) > 15: score += 1
    if abs(macd_hist) > 0: score += 1
    if volume_ratio > 1.3: score += 1
    if score >= 3: return "high"
    if score >= 2: return "medium"
    return "low"


def analyze_ticker(ticker: str, md: dict) -> dict | None:
    """Compute a simple signal from pre-fetched market data (see market_data.py)."""
    try:
        import ta
        df = md["df"]
        if len(df) < MIN_BARS:
            print(f"  ⚠  {ticker}: insufficient data ({len(df)} bars)")
            return None

        close = df["Close"]
        volume = df["Volume"]

        rsi = ta.momentum.RSIIndicator(close, window=14).rsi().iloc[-1]
        macd = ta.trend.MACD(close)
        macd_hist = macd.macd_diff().iloc[-1]
        sma20 = close.rolling(20).mean().iloc[-1]
        price = md["price"]
        avg_vol = volume.rolling(20).mean().iloc[-1]
        vol_ratio = volume.iloc[-1] / avg_vol if avg_vol > 0 else 1.0

        price_vs_sma = (price - sma20) / sma20

        indicators = ["RSI", "MACD"]
        if vol_ratio > 1.3: indicators.append("High Volume")
        if abs(price_vs_sma) > 0.02: indicators.append("SMA20")

        direction = _direction(rsi, macd_hist, price_vs_sma)
        confidence = _confidence(rsi, macd_hist, vol_ratio)

        change_pct = ((price - md["prev_close"]) / md["prev_close"]) * 100

        return {
            "id": f"{ticker}-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
            "ticker": ticker,
            "direction": direction,
            "timeframe": "short",
            "confidence": confidence,
            "title": f"{ticker} {direction} signal ({confidence} confidence)",
            "explanation": (
                f"RSI at {rsi:.1f} ({'overbought' if rsi > 70 else 'oversold' if rsi < 30 else 'neutral'}). "
                f"MACD histogram {'positive' if macd_hist > 0 else 'negative'} at {macd_hist:.3f}. "
                f"Price {abs(price_vs_sma)*100:.1f}% {'above' if price_vs_sma > 0 else 'below'} 20-day SMA. "
                f"Volume {vol_ratio:.1f}x the 20-day average."
            ),
            "indicators": indicators,
            "price": round(float(price), 2),
            "change_pct": round(float(change_pct), 2),
            "rsi": round(float(rsi), 1),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "source": md["source"],
        }
    except Exception as e:
        print(f"  ✗  {ticker}: {e}")
        return None


# ---------------------------------------------------------------------------
# Finnhub news sentiment (optional enrichment)
# ---------------------------------------------------------------------------

def get_news_sentiment(ticker: str, finnhub_key: str | None) -> str | None:
    if not finnhub_key:
        return None
    try:
        import finnhub
        client = finnhub.Client(api_key=finnhub_key)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        news = client.company_news(ticker, _from=today, to=today)
        if not news:
            return None
        return f"{len(news)} news items today"
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Firestore write
# ---------------------------------------------------------------------------

def push_to_firestore(signals: list[dict], dry_run: bool) -> bool:
    """Return True when the digest was written (or nothing was requested in dry-run)."""
    print("\n📦 Firestore push...")
    if dry_run:
        print("  [dry-run] Would write", len(signals), "signals to Firestore collection 'nwf_digest'")
        return True
    try:
        from google.cloud import firestore
        db = firestore.Client(project="ttb-lang1")
        batch = db.batch()
        date_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        doc_ref = db.collection("nwf_digest").document(date_key)
        batch.set(doc_ref, {
            "schemaVersion": 1,
            "periodLabel": f"Week of {datetime.now(timezone.utc).strftime('%b %-d')}",
            "signals": signals,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sources": sorted({f"{s['source']}-local" for s in signals}),
        })
        batch.commit()
        print(f"  ✓  Wrote digest to nwf_digest/{date_key}")
        return True
    except ImportError:
        print("  ⚠  google-cloud-firestore not installed. Run: mamba install -c conda-forge google-cloud-firestore")
    except Exception as e:
        print(f"  ✗  Firestore error: {e}")
    return False


# ---------------------------------------------------------------------------
# Portal cache push (hits /refresh/bake on the live backend, or a custom endpoint)
# ---------------------------------------------------------------------------

def push_to_portal(signals: list[dict], dry_run: bool) -> bool:
    """Return True when the portal accepted the digest (or nothing was requested in dry-run)."""
    import requests
    portal_url = os.getenv("EXPO_PUBLIC_PORTAL_URL", "https://financial.nuwrrrld.com")
    secret = os.getenv("PORTAL_PUSH_SECRET", "")

    digest = {
        "schemaVersion": 1,
        "periodLabel": f"Week of {datetime.now(timezone.utc).strftime('%b %-d')}",
        "signals": signals,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": sorted({f"{s['source']}-local" for s in signals}),
    }

    print(f"\n🌐 Portal push → {portal_url}/api/signals/refresh")
    if dry_run:
        print("  [dry-run] Would POST", len(signals), "signals to portal")
        print(json.dumps(digest, indent=2)[:800])
        return True

    published = False
    try:
        res = requests.post(
            f"{portal_url}/api/signals/refresh",
            json=digest,
            headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
            timeout=10,
        )
        published = res.ok
        if res.ok:
            print(f"  ✓  Portal responded {res.status_code}")
        else:
            print(f"  ⚠  Portal {res.status_code}: {res.text[:200]}")
    except Exception as e:
        print(f"  ✗  Portal push failed: {e}")

    # Also try hitting the GCP3 backend refresh endpoint directly
    gcp3_url = "https://gcp3-backend-cif7ppahzq-uc.a.run.app"
    print(f"\n🔄 GCP3 backend refresh → {gcp3_url}/refresh/bake")
    if dry_run:
        print("  [dry-run] Would POST to GCP3 /refresh/bake")
        return published
    try:
        res2 = requests.post(f"{gcp3_url}/refresh/bake", timeout=30)
        print(f"  GCP3 /refresh/bake: {res2.status_code} {res2.text[:100]}")
    except Exception as e:
        print(f"  GCP3 refresh failed: {e}")
    return published


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh NuWrrrld signal digest locally")
    parser.add_argument("--tickers", nargs="+", help="Override ticker list")
    parser.add_argument("--universe", default="beta1", choices=list(UNIVERSES.keys()),
                        help="Predefined universe to scan (default: beta1)")
    parser.add_argument("--push", action="store_true", help="Push digest to portal")
    parser.add_argument("--firestore", action="store_true", help="Write to Firestore")
    parser.add_argument("--dry-run", action="store_true", help="No writes — print only")
    parser.add_argument("--period", default="3mo", choices=PERIOD_CHOICES,
                        help="history window: 3mo, 6mo or 1y (default: 3mo)")
    args = parser.parse_args()

    tickers = args.tickers or UNIVERSES[args.universe]
    finnhub_key = os.getenv("FINNHUB_API_KEY")

    print(f"\n{'='*60}")
    print(f"NuWrrrld Signal Refresh — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Universe: {args.universe} ({len(tickers)} tickers)")
    print(f"{'='*60}\n")

    signals: list[dict] = []
    market = load_market_data(tickers, args.period)
    for ticker in tickers:
        print(f"  → {ticker}", end=" ", flush=True)
        sig = analyze_ticker(ticker, market[ticker]) if ticker in market else None
        if sig:
            # Optional Finnhub news enrichment
            news_note = get_news_sentiment(ticker, finnhub_key)
            if news_note:
                sig["explanation"] += f" {news_note}."
            signals.append(sig)
            arrow = "↑" if sig["direction"] == "bullish" else "↓" if sig["direction"] == "bearish" else "→"
            print(f"{arrow} {sig['direction']} ({sig['confidence']}) RSI={sig['rsi']} price=${sig['price']:.2f} {sig['change_pct']:+.1f}%")

    print(f"\n✓  {len(signals)}/{len(tickers)} signals generated\n")

    # Print digest summary
    for s in sorted(signals, key=lambda x: ("bearish", "neutral", "bullish").index(x["direction"])):
        print(f"  {s['ticker']:<6} {s['direction']:<8} {s['confidence']:<6} RSI={s['rsi']:.0f}")

    if not args.push and not args.firestore:
        print("\n💡 Add --push to push to portal, --firestore to write to Firestore")
        print("   Add --dry-run to preview without writing")

    # An empty digest would replace the cached/persisted one, so publish nothing and fail loudly.
    publication_failed = False
    if (args.firestore or args.push) and not signals:
        print("\n✗  No signals generated; skipping publication so the previous digest is kept.")
        publication_failed = True
    else:
        if args.firestore and not push_to_firestore(signals, dry_run=args.dry_run):
            publication_failed = True
        if args.push and not push_to_portal(signals, dry_run=args.dry_run):
            publication_failed = True

    if publication_failed:
        print(f"\nFailed. {len(signals)} signals ready, but a requested publication did not complete.\n")
        sys.exit(1)
    print(f"\nDone. {len(signals)} signals ready.\n")


if __name__ == "__main__":
    main()
