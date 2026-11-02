#!/usr/bin/env python3
"""
locrun — NuWrrrld local pipeline runner.

Fetches fresh signal data via Alpaca (yfinance fallback), fills all Firestore
collections used by GCP3 and the finance backends, pushes to the portal
cache, and generates a self-contained HTML report.

Usage:
    mamba activate fin-ai1
    python scripts/pipeline/locrun.py [OPTIONS]

Options:
    --universe beta1|nasdaq100_top|sp500_top|etf_sector|all
    --tickers AAPL NVDA ...   Override ticker list
    --push                    Push digest to portal
    --no-firestore            Skip Firestore writes
    --no-gcp3                 Skip GCP3 backend refresh trigger
    --output DIR              Directory for HTML report (default: ~/Desktop)
    --open                    Open HTML report in browser after generation
    --dry-run                 Print only — no writes, no push
"""

from __future__ import annotations
import argparse, json, os, subprocess, sys, time, webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ── Env ───────────────────────────────────────────────────────────────────
# scripts/pipeline/ -> repo root -> ~/code; mcp-finance1 is a sibling checkout of this repo
_ROOT = Path(__file__).resolve().parents[3] / "gcp-app-w-mcp1" / "mcp-finance1"
try:
    from dotenv import load_dotenv
    load_dotenv(_ROOT / ".env")
    load_dotenv(_ROOT / ".env.local", override=False)
except ImportError:
    pass

FINNHUB_KEY   = os.getenv("FINNHUB_API_KEY", "")
PORTAL_URL    = os.getenv("EXPO_PUBLIC_PORTAL_URL", "https://financial.nuwrrrld.com")
PUSH_SECRET   = os.getenv("PORTAL_PUSH_SECRET", "")
GCP3_URL      = "https://gcp3-backend-cif7ppahzq-uc.a.run.app"

# ── Universes ─────────────────────────────────────────────────────────────
UNIVERSES: dict[str, list[str]] = {
    "beta1":         ["MU", "GLD", "NVDA", "RGTI", "PL", "GEV", "GOOG", "IBIT", "APLD"],
    "nasdaq100_top": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AVGO", "COST", "NFLX"],
    "sp500_top":     ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "JPM", "V", "UNH"],
    "etf_sector":    ["XLK", "XLF", "XLV", "XLE", "XLY", "XLP", "XLI", "XLB", "XLU", "XLRE"],
}

# ── Imports ───────────────────────────────────────────────────────────────
try:
    import yfinance as yf  # fallback only: Alpaca is the primary source (market-data-fallback rule)
    import pandas as pd
    import ta
    import requests
except ImportError as e:
    sys.exit(f"Missing dependency: {e}\nRun: mamba install -c conda-forge yfinance pandas ta requests")

import logging
from html import escape as html_escape

from market_data import MIN_BARS, PERIOD_CHOICES, load_market_data

logging.basicConfig(level=logging.INFO, format="  %(levelname)s %(message)s")

# ── Analysis ──────────────────────────────────────────────────────────────

def analyze(ticker: str, md: dict) -> dict | None:
    try:
        df = md["df"]
        if len(df) < MIN_BARS:  # below this, MACD signal and histogram are NaN
            return None
        c = df["Close"]; v = df["Volume"]
        rsi  = float(ta.momentum.RSIIndicator(c, 14).rsi().iloc[-1])
        macd_obj = ta.trend.MACD(c)
        macd     = float(macd_obj.macd().iloc[-1])
        macd_sig = float(macd_obj.macd_signal().iloc[-1])
        macd_hist= float(macd_obj.macd_diff().iloc[-1])
        bb       = ta.volatility.BollingerBands(c)
        bb_upper = float(bb.bollinger_hband().iloc[-1])
        bb_lower = float(bb.bollinger_lband().iloc[-1])
        bb_mid   = float(bb.bollinger_mavg().iloc[-1])
        sma20    = float(c.rolling(20).mean().iloc[-1])
        sma50    = float(c.rolling(50).mean().iloc[-1]) if len(c) >= 50 else sma20
        ema20    = float(c.ewm(span=20).mean().iloc[-1])
        avg_vol  = float(v.rolling(20).mean().iloc[-1])
        vol_ratio= float(v.iloc[-1]) / avg_vol if avg_vol > 0 else 1.0

        price, prev_close = md["price"], md["prev_close"]
        change_pct  = (price - prev_close) / prev_close * 100 if prev_close else 0.0
        data_ts     = md["data_as_of"]
        name        = ""  # Alpaca bars carry no company name

        price_vs_sma = (price - sma20) / sma20

        # Direction / confidence
        bull = sum([rsi > 55, macd_hist > 0, price_vs_sma > 0, vol_ratio > 1.2])
        bear = sum([rsi < 45, macd_hist < 0, price_vs_sma < 0, vol_ratio < 0.8])
        direction  = "bullish" if bull >= 3 else "bearish" if bear >= 3 else \
                     "bullish" if bull >= 2 else "bearish" if bear >= 2 else "neutral"
        ai_score   = round(50 + (bull - bear) * 12.5)
        ai_action  = "BUY" if ai_score >= 70 else "SELL" if ai_score <= 30 else "HOLD"
        ai_outlook = "BULLISH" if ai_score >= 70 else "BEARISH" if ai_score <= 30 else "NEUTRAL"
        conf_score = abs(bull - bear)
        confidence = "high" if conf_score >= 3 else "medium" if conf_score >= 2 else "low"
        ai_confidence = confidence.upper()

        inds: list[str] = []
        if abs(rsi - 50) > 10: inds.append(f"RSI {rsi:.0f}")
        if abs(macd_hist) > 0:  inds.append("MACD")
        if vol_ratio > 1.3:     inds.append(f"Volume {vol_ratio:.1f}x")
        if abs(price_vs_sma) > 0.02: inds.append(f"SMA20 {price_vs_sma*100:+.1f}%")

        explanation = (
            f"RSI at {rsi:.1f} ({'overbought' if rsi>70 else 'oversold' if rsi<30 else 'neutral'}). "
            f"MACD histogram {macd_hist:+.3f}. "
            f"Price {abs(price_vs_sma)*100:.1f}% {'above' if price_vs_sma>0 else 'below'} 20-day SMA. "
            f"Volume {vol_ratio:.1f}x average."
        )

        signals_list = []
        if rsi > 60:  signals_list.append({"signal": f"RSI {rsi:.0f} — momentum bullish", "strength": "BULLISH", "category": "momentum"})
        if rsi < 40:  signals_list.append({"signal": f"RSI {rsi:.0f} — oversold", "strength": "BEARISH", "category": "momentum"})
        if macd_hist > 0: signals_list.append({"signal": "MACD histogram positive", "strength": "BULLISH", "category": "trend"})
        if macd_hist < 0: signals_list.append({"signal": "MACD histogram negative", "strength": "BEARISH", "category": "trend"})
        if vol_ratio > 1.3: signals_list.append({"signal": f"Volume surge {vol_ratio:.1f}x", "strength": "BULLISH", "category": "volume"})

        bb_pct = (price - bb_lower) / (bb_upper - bb_lower) if (bb_upper - bb_lower) > 0 else 0.5

        return {
            # NWF digest fields
            "id": f"{ticker}-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
            "ticker": ticker,
            "name": name,
            "direction": direction,
            "timeframe": "short",
            "confidence": confidence,
            "title": f"{ticker} {direction} signal ({confidence} confidence)",
            "explanation": explanation,
            "indicators": inds,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "data_as_of": data_ts,
            "source": md["source"],
            # Firestore `analysis` collection fields
            "symbol": ticker,
            "price": round(price, 2),
            "prev_close": round(prev_close, 2),
            "change_pct": round(change_pct, 2),
            "signal_count": len(signals_list),
            "signals": signals_list,
            "ai_score": ai_score,
            "ai_action": ai_action,
            "ai_outlook": ai_outlook,
            "ai_confidence": ai_confidence,
            "ai_summary": f"{ticker} {ai_action} — RSI {rsi:.0f}, MACD {macd_hist:+.2f}, vol {vol_ratio:.1f}x",
            "ai_powered": False,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "indicators_raw": {
                "rsi": round(rsi, 2),
                "macd": round(macd, 4),
                "macd_signal": round(macd_sig, 4),
                "macd_hist": round(macd_hist, 4),
                "bb_upper": round(bb_upper, 2),
                "bb_lower": round(bb_lower, 2),
                "bb_mid": round(bb_mid, 2),
                "bb_pct": round(bb_pct, 3),
                "sma20": round(sma20, 2),
                "sma50": round(sma50, 2),
                "ema20": round(ema20, 2),
                "volume_ratio": round(vol_ratio, 2),
            },
        }
    except Exception as e:
        print(f"  ✗ {ticker}: {e}")
        return None

# ── GCP3 refresh ─────────────────────────────────────────────────────────

def _sources(results: list[dict]) -> list[str]:
    return sorted({f"{r.get('source', 'unknown')}-local" for r in results}) or ["alpaca-local"]


def trigger_gcp3_refresh(dry_run: bool) -> dict:
    if dry_run:
        return {"skipped": True, "reason": "dry-run"}
    results = {}
    for endpoint in ["/refresh/bake", "/refresh/ai-summary"]:
        try:
            r = requests.post(f"{GCP3_URL}{endpoint}", timeout=30)
            results[endpoint] = r.status_code
            print(f"  GCP3 {endpoint}: {r.status_code}")
        except Exception as e:
            results[endpoint] = str(e)
    return results

# ── Firestore write ───────────────────────────────────────────────────────

def write_firestore(results: list[dict], universe: str, elapsed: float, dry_run: bool,
                    expected: int) -> dict:
    summary: dict[str, Any] = {}
    if dry_run:
        print("  [dry-run] Would write to Firestore")
        return {"skipped": True}
    try:
        from google.cloud import firestore as fs
        db = fs.Client(project="ttb-lang1")
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        # A partial run must not replace the day's complete publication; it gets its own key.
        complete = len(results) == expected
        day_key = today if complete else f"{today}-partial-{datetime.now(timezone.utc):%H%M%S}"
        if not complete:
            print(f"  ⚠ Firestore: partial run ({len(results)}/{expected}); day docs go to {day_key}")
        batch = db.batch()

        # analysis collection — one doc per symbol
        for r in results:
            ref = db.collection("analysis").document(r["symbol"])
            batch.set(ref, {
                "symbol": r["symbol"],
                "price": r["price"],
                "change_pct": r["change_pct"],
                "signal_count": r["signal_count"],
                "signals": r["signals"],
                "indicators": r["indicators_raw"],
                "ai_score": r["ai_score"],
                "ai_action": r["ai_action"],
                "ai_outlook": r["ai_outlook"],
                "ai_confidence": r["ai_confidence"],
                "ai_summary": r["ai_summary"],
                "ai_powered": r["ai_powered"],
                "timestamp": r["timestamp"],
            })

        # summaries collection
        bullish = [r for r in results if r["direction"] == "bullish"]
        bearish = [r for r in results if r["direction"] == "bearish"]
        high_conf = [r for r in results if r["confidence"] == "high"]
        batch.set(db.collection("summaries").document(day_key), {
            "date": today,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total_analyzed": len(results),
            "successful": len(results),
            "errors": expected - len(results),
            "top_bullish": sorted(bullish, key=lambda x: x["ai_score"], reverse=True)[:5],
            "top_bearish": sorted(bearish, key=lambda x: x["ai_score"])[:5],
            "high_confidence": high_conf,
        })

        # scans collection
        batch.set(db.collection("scans").document(day_key), {
            "universe": universe,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "total_scanned": len(results),
            "duration_seconds": round(elapsed, 2),
            "qualified_trades": [r for r in results if r["ai_action"] in ("BUY", "SELL")],
            "metadata": {"source": "locrun", "version": "2.0", "symbols": [r["symbol"] for r in results]},
        })

        # gcp3_cache
        batch.set(db.collection("gcp3_cache").document(day_key), {
            "date": today,
            "updated_at": fs.SERVER_TIMESTAMP,
            "count": len(results),
            "source": "locrun",
        })

        # nwf_digest — NuWrrrld portal digest
        batch.set(db.collection("nwf_digest").document(day_key), {
            "schemaVersion": 1,
            "periodLabel": f"Week of {datetime.now(timezone.utc).strftime('%b %-d')}",
            "signals": [{k: r[k] for k in ("id","ticker","direction","timeframe","confidence",
                         "title","explanation","indicators","generatedAt")} for r in results],
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sources": _sources(results),
        })

        batch.commit()
        summary = {"analysis": len(results), "summaries": 1, "scans": 1, "gcp3_cache": 1, "nwf_digest": 1}
        print(f"  ✓ Firestore: wrote {len(results)} analysis docs + summaries + scans + gcp3_cache + nwf_digest")
    except Exception as e:
        print(f"  ✗ Firestore error: {e}")
        summary["error"] = str(e)
    return summary

# ── Portal push ───────────────────────────────────────────────────────────

def push_portal(results: list[dict], dry_run: bool) -> dict:
    digest = {
        "schemaVersion": 1,
        "periodLabel": f"Week of {datetime.now(timezone.utc).strftime('%b %-d')}",
        "signals": [{k: r[k] for k in ("id","ticker","direction","timeframe","confidence",
                     "title","explanation","indicators","generatedAt")} for r in results],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": _sources(results),
    }
    if not results:  # the portal replaces its cached digest; an empty run must not blank it
        print("  ✗ Portal push skipped: no signals generated")
        return {"skipped": "no signals"}
    if dry_run:
        print(f"  [dry-run] Would POST {len(results)} signals to {PORTAL_URL}/api/signals/refresh")
        return {"skipped": True}
    try:
        r = requests.post(f"{PORTAL_URL}/api/signals/refresh",
                          json=digest, timeout=15,
                          headers={"Authorization": f"Bearer {PUSH_SECRET}", "Content-Type": "application/json"})
        print(f"  Portal push: {r.status_code} {r.text[:80]}")
        return {"status": r.status_code}
    except Exception as e:
        print(f"  ✗ Portal push: {e}")
        return {"error": str(e)}

# ── HTML report ───────────────────────────────────────────────────────────

def generate_html(results: list[dict], gcp3_data: dict, meta: dict, out_path: Path) -> Path:
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def badge(direction: str) -> str:
        colors = {"bullish": "#16a34a", "bearish": "#dc2626", "neutral": "#d97706"}
        arrows = {"bullish": "↑", "bearish": "↓", "neutral": "→"}
        c = colors.get(direction, "#888")
        a = arrows.get(direction, "→")
        return f'<span style="color:{c};font-weight:700">{a} {direction}</span>'

    def conf_badge(c: str) -> str:
        colors = {"high": "#2563eb", "medium": "#7c3aed", "low": "#9ca3af"}
        col = colors.get(c, "#888")
        return f'<span style="background:{col};color:#fff;padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:700">{c}</span>'

    rows = ""
    for r in sorted(results, key=lambda x: -x["ai_score"]):
        ind_str = ", ".join(r["indicators"]) if r["indicators"] else "—"
        chg_color = '#16a34a' if r['change_pct'] >= 0 else '#dc2626'
        rows += f"""
        <tr>
          <td>
            <strong>{r['symbol']}</strong>
            <div style="font-size:.72rem;color:#6b7280;margin-top:2px">{r.get('name','')[:35]}</div>
          </td>
          <td>{badge(r['direction'])}</td>
          <td>{conf_badge(r['confidence'])}</td>
          <td>
            <strong>${r['price']:.2f}</strong>
            <span style="color:{chg_color};font-weight:600;margin-left:4px">{r['change_pct']:+.2f}%</span>
            <div style="font-size:.72rem;color:#9ca3af">prev {r.get('prev_close', r['price']):.2f}</div>
          </td>
          <td style="font-size:.78rem;color:#555">{r['data_as_of']}</td>
          <td>{r['ai_score']}</td>
          <td><span style="color:{'#16a34a' if r['ai_action']=='BUY' else '#dc2626' if r['ai_action']=='SELL' else '#888'};font-weight:700">{r['ai_action']}</span></td>
          <td style="font-size:.78rem;color:#555">{r['indicators_raw']['rsi']:.0f} RSI · {r['indicators_raw']['macd_hist']:+.3f} MACD · {r['indicators_raw']['volume_ratio']:.1f}x vol</td>
          <td style="font-size:.78rem">{ind_str}</td>
        </tr>"""

    # Summary stats
    bull_ct = sum(1 for r in results if r["direction"] == "bullish")
    bear_ct = sum(1 for r in results if r["direction"] == "bearish")
    neut_ct = sum(1 for r in results if r["direction"] == "neutral")
    high_ct = sum(1 for r in results if r["confidence"] == "high")

    # GCP3 section (signals endpoint data)
    gcp3_rows = ""
    for sym, sig in list(gcp3_data.items())[:20]:
        action = sig.get("ai_action","—")
        score  = sig.get("ai_score", sig.get("confluence_score", 0))
        chg    = sig.get("change_pct", 0)
        gcp3_rows += f"""<tr>
          <td><strong>{sym}</strong></td>
          <td><span style="color:{'#16a34a' if action=='BUY' else '#dc2626' if action=='SELL' else '#888'};font-weight:700">{action}</span></td>
          <td>{score}</td>
          <td style="color:{'#16a34a' if chg>=0 else '#dc2626'}">{chg:+.1f}%</td>
          <td style="font-size:.75rem;color:#555">{html_escape(str(sig.get('ai_summary',''))[:80])}</td>
        </tr>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>NuWrrrld locrun — {date_str}</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f9fafb;color:#111;line-height:1.5}}
    .header{{background:linear-gradient(135deg,#08090c,#0c0e12);color:#fff;padding:2rem 2.5rem}}
    .header h1{{font-size:1.8rem;font-weight:800;letter-spacing:-.04em}}
    .header .meta{{color:#aba89e;font-size:.88rem;margin-top:.4rem}}
    .stats{{display:flex;gap:1rem;padding:1.5rem 2.5rem;background:#fff;border-bottom:1px solid #e5e7eb;flex-wrap:wrap}}
    .stat{{padding:.75rem 1.25rem;border:1px solid #e5e7eb;border-radius:10px;min-width:110px;text-align:center}}
    .stat .num{{font-size:1.8rem;font-weight:800}}
    .stat .lbl{{font-size:.75rem;color:#6b7280;margin-top:.2rem}}
    .green{{color:#16a34a}}.red{{color:#dc2626}}.amber{{color:#d97706}}.blue{{color:#2563eb}}
    section{{margin:1.5rem 2.5rem}}
    h2{{font-size:1.1rem;font-weight:700;margin-bottom:.75rem;padding-bottom:.4rem;border-bottom:2px solid #e5e7eb}}
    table{{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)}}
    th{{background:#f3f4f6;padding:.65rem 1rem;font-size:.78rem;text-align:left;color:#374151;font-weight:700;text-transform:uppercase;letter-spacing:.04em}}
    td{{padding:.65rem 1rem;border-bottom:1px solid #f3f4f6;font-size:.88rem}}
    tr:last-child td{{border-bottom:none}}
    tr:hover td{{background:#f9fafb}}
    .signal-card{{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;margin-bottom:.75rem}}
    .signal-card .ticker{{font-size:1.1rem;font-weight:700}}
    .signal-card .expl{{color:#555;font-size:.85rem;margin-top:.35rem;line-height:1.55}}
    .pill{{padding:.2rem .65rem;border-radius:20px;font-size:.72rem;font-weight:700}}
    .pill-buy{{background:#dcfce7;color:#166534}}.pill-sell{{background:#fee2e2;color:#991b1b}}.pill-hold{{background:#f3f4f6;color:#374151}}
    .footer{{padding:1.5rem 2.5rem;font-size:.8rem;color:#9ca3af;border-top:1px solid #e5e7eb;margin-top:2rem}}
    @media(max-width:700px){{section{{margin:1rem}}.stats{{padding:1rem}}.header{{padding:1.25rem}}table{{font-size:.78rem}}}}
  </style>
</head>
<body>
  <div class="header">
    <h1>🚀 NuWrrrld locrun</h1>
    <div class="meta">Generated {now_str} · Universe: {meta['universe']} · {meta['total']} tickers · {meta['elapsed']:.1f}s</div>
  </div>

  <div class="stats">
    <div class="stat"><div class="num">{meta['total']}</div><div class="lbl">Analyzed</div></div>
    <div class="stat"><div class="num green">{bull_ct}</div><div class="lbl">Bullish</div></div>
    <div class="stat"><div class="num red">{bear_ct}</div><div class="lbl">Bearish</div></div>
    <div class="stat"><div class="num amber">{neut_ct}</div><div class="lbl">Neutral</div></div>
    <div class="stat"><div class="num blue">{high_ct}</div><div class="lbl">High Conf</div></div>
    <div class="stat"><div class="num">{meta.get('firestore_docs',0)}</div><div class="lbl">Firestore docs</div></div>
  </div>

  <section>
    <h2>📈 Local Alpaca + TA Analysis</h2>
    <table>
      <thead><tr>
        <th>Symbol / Name</th><th>Direction</th><th>Confidence</th>
        <th>Price · Change</th><th>Data As Of</th>
        <th>Score</th><th>Action</th><th>Indicators (raw)</th><th>Signals</th>
      </tr></thead>
      <tbody>{rows}</tbody>
    </table>
  </section>

  <section>
    <h2>💡 Signal Explanations</h2>
    {"".join(f'''<div class="signal-card">
      <div style="display:flex;align-items:center;gap:.75rem">
        <span class="ticker">{r['symbol']}</span>
        <span class="pill pill-{'buy' if r['ai_action']=='BUY' else 'sell' if r['ai_action']=='SELL' else 'hold'}">{r['ai_action']}</span>
      </div>
      <div class="expl">{r['explanation']}</div>
    </div>''' for r in sorted(results, key=lambda x: -x['ai_score']))}
  </section>

  {"" if not gcp3_rows else f'''<section>
    <h2>🌐 GCP3 Backend Signals (industry/sector)</h2>
    <table>
      <thead><tr><th>Symbol</th><th>Action</th><th>Score</th><th>Change</th><th>Summary</th></tr></thead>
      <tbody>{gcp3_rows}</tbody>
    </table>
  </section>'''}

  <section>
    <h2>🗄️ Firestore Collections Updated</h2>
    <table>
      <thead><tr><th>Collection</th><th>Documents</th><th>Key Fields</th></tr></thead>
      <tbody>
        <tr><td><strong>analysis</strong></td><td>{meta['total']}</td><td>symbol, price, ai_score, ai_action, indicators, signals</td></tr>
        <tr><td><strong>summaries</strong></td><td>1 (today)</td><td>top_bullish, top_bearish, high_confidence, totals</td></tr>
        <tr><td><strong>scans</strong></td><td>1 (today)</td><td>universe, qualified_trades, duration_seconds</td></tr>
        <tr><td><strong>gcp3_cache</strong></td><td>1 (today)</td><td>count, updated_at, source</td></tr>
        <tr><td><strong>nwf_digest</strong></td><td>1 (today)</td><td>schemaVersion, signals[], generatedAt</td></tr>
      </tbody>
    </table>
  </section>

  <div class="footer">
    locrun v2.0 · NuWrrrld Financial · Not financial advice ·
    Source: Alpaca (yfinance fallback) + ta-lib · GCP3: {GCP3_URL}
  </div>
</body>
</html>"""

    out_path.write_text(html, encoding="utf-8")
    return out_path

def _firestore_doc_count(firestore_result: dict) -> int:
    """Docs actually committed: zero for dry-run, skipped, or failed writes."""
    if firestore_result.get("skipped") or "error" in firestore_result:
        return 0
    return sum(v for v in firestore_result.values() if isinstance(v, int))


# ── Main ──────────────────────────────────────────────────────────────────

def main() -> None:
    p = argparse.ArgumentParser(description="NuWrrrld local pipeline runner")
    p.add_argument("--universe", default="beta1", choices=[*UNIVERSES, "all"])
    p.add_argument("--tickers", nargs="+")
    p.add_argument("--push", action="store_true")
    p.add_argument("--no-firestore", action="store_true")
    p.add_argument("--no-gcp3", action="store_true")
    p.add_argument("--output", default=os.path.expanduser("~/Desktop"))
    p.add_argument("--open", action="store_true", dest="open_browser")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--period", default="3mo", choices=PERIOD_CHOICES)
    args = p.parse_args()
    # Create the report directory before any remote write, so a bad path fails before publication.
    Path(args.output).mkdir(parents=True, exist_ok=True)

    if args.tickers:
        tickers = args.tickers
    elif args.universe == "all":
        tickers = sorted({t for lst in UNIVERSES.values() for t in lst})
    else:
        tickers = UNIVERSES[args.universe]

    print(f"\n{'='*60}")
    print(f"  locrun — {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"  Universe: {args.universe}  |  {len(tickers)} tickers")
    print(f"{'='*60}\n")

    t0 = time.time()
    results: list[dict] = []
    market = load_market_data(tickers, args.period)
    for ticker in tickers:
        print(f"  → {ticker}", end=" ", flush=True)
        r = analyze(ticker, market[ticker]) if ticker in market else None
        if r:
            results.append(r)
            arrow = {"bullish":"↑","bearish":"↓","neutral":"→"}.get(r["direction"],"→")
            print(f"{arrow} {r['direction']:<8} {r['confidence']:<6} score={r['ai_score']:>3} ${r['price']:>8.2f} {r['change_pct']:>+6.2f}%  [{r['source']} {r['data_as_of']}]")
        else:
            print("✗ no data")
    elapsed = time.time() - t0

    print(f"\n  ✓ {len(results)}/{len(tickers)} analyzed in {elapsed:.1f}s\n")

    # GCP3 backend refresh
    gcp3_signals: dict = {}
    if not args.no_gcp3:
        print("── GCP3 backend ──────────────────────────────────")
        trigger_gcp3_refresh(dry_run=args.dry_run)
        try:
            r2 = requests.get(f"{GCP3_URL}/signals", timeout=15)
            if r2.ok:
                data = r2.json()
                gcp3_signals = data.get("symbols", {})
                print(f"  GCP3 /signals: {len(gcp3_signals)} symbols fetched")
        except Exception as e:
            print(f"  GCP3 /signals: {e}")
        print()

    # Firestore
    firestore_result: dict = {}
    if not args.no_firestore:
        print("── Firestore ─────────────────────────────────────")
        firestore_result = write_firestore(results, args.universe, elapsed, dry_run=args.dry_run,
                                           expected=len(tickers))
        print()

    # Portal push
    if args.push:
        print("── Portal push ───────────────────────────────────")
        push_portal(results, dry_run=args.dry_run)
        print()

    # HTML report
    print("── HTML report ───────────────────────────────────")
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_file = Path(args.output) / f"locrun-{date_str}.html"
    meta = {
        "universe": args.universe, "total": len(results),
        "elapsed": elapsed, "firestore_docs": _firestore_doc_count(firestore_result),
    }
    generate_html(results, gcp3_signals, meta, out_file)
    print(f"  ✓ Report saved: {out_file}")

    if args.open_browser:
        webbrowser.open(f"file://{out_file}")

    print(f"\n{'='*60}")
    print(f"  Done. {len(results)} signals · report: {out_file.name}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
