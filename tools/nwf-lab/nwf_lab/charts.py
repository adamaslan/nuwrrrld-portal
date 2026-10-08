"""Plotly/DataFrame builders shared by summary.html, the Streamlit app and the notebook."""
from __future__ import annotations

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FeatureResult

STATUS_COLOR = {
    "ok": "#2e7d32", "vendor_gap": "#ef6c00", "skipped_llm": "#9e9e9e",
    "skipped_input": "#78909c", "error": "#c62828",
}


def status_table(results: dict[str, FeatureResult]) -> pd.DataFrame:
    return pd.DataFrame(
        [{"slug": s, "status": r.status, "sources": ", ".join(r.sources), "note": r.note or ""}
         for s, r in results.items()]
    )


def status_grid(results: dict[str, FeatureResult]) -> go.Figure:
    df = status_table(results)
    fig = go.Figure(go.Table(
        header=dict(values=["feature", "status", "sources", "note"], align="left"),
        cells=dict(values=[df[c] for c in df], align="left",
                   font_color=[["black"] * len(df), [STATUS_COLOR[s] for s in df["status"]],
                               ["black"] * len(df), ["black"] * len(df)]),
    ))
    fig.update_layout(margin=dict(l=0, r=0, t=10, b=0), height=60 + 28 * len(df))
    return fig


def candles_with_bands(bundle: DataBundle, results: dict[str, FeatureResult], symbol: str) -> go.Figure:
    df = bundle.bars[symbol]
    fr = results["analyze"].frames[symbol]
    fig = make_subplots(rows=3, cols=1, shared_xaxes=True, row_heights=[0.6, 0.2, 0.2],
                        vertical_spacing=0.03)
    fig.add_trace(go.Candlestick(x=df.index, open=df.open, high=df.high, low=df.low, close=df.close,
                                 name=symbol), row=1, col=1)
    for col, color in (("bb_upper", "#90a4ae"), ("bb_lower", "#90a4ae"), ("sma_fast", "#1565c0"),
                       ("sma_slow", "#6a1b9a")):
        fig.add_trace(go.Scatter(x=fr.index, y=fr[col], name=col, line=dict(width=1, color=color)),
                      row=1, col=1)
    fig.add_trace(go.Scatter(x=fr.index, y=fr.rsi, name="RSI"), row=2, col=1)
    fig.add_trace(go.Bar(x=fr.index, y=fr.macd_hist, name="MACD hist"), row=3, col=1)
    fig.update_layout(height=640, xaxis_rangeslider_visible=False, margin=dict(l=0, r=0, t=20, b=0))
    return fig


def backtest_equity(result: FeatureResult, symbol: str | None = None) -> go.Figure:
    fig = go.Figure()
    for sym, tdf in result.frames.items():
        if symbol and sym != symbol or tdf.empty:
            continue
        fig.add_trace(go.Scatter(x=tdf["exit_date"], y=tdf["equity"], name=sym, mode="lines+markers"))
    fig.update_layout(height=360, yaxis_title="equity (x)", margin=dict(l=0, r=0, t=20, b=0))
    return fig


def leaderboard(result: FeatureResult) -> go.Figure:
    df = result.frames["ranked"]
    fig = go.Figure(go.Bar(x=df["ticker"], y=df["ai_score"], text=df["ai_action"]))
    fig.update_layout(height=320, yaxis_title="ai_score", margin=dict(l=0, r=0, t=20, b=0))
    return fig


def nav_curve(result: FeatureResult) -> go.Figure:
    nav = result.frames["nav"]
    fig = go.Figure(go.Scatter(x=nav.index, y=nav["nav"], name="NAV"))
    fig.update_layout(height=320, margin=dict(l=0, r=0, t=20, b=0))
    return fig


def sector_treemap(result: FeatureResult) -> go.Figure:
    w = result.data["sector_weights"]
    return go.Figure(go.Treemap(labels=list(w), parents=[""] * len(w), values=list(w.values())))


def diff_table(before: dict[str, FeatureResult], after: dict[str, FeatureResult]) -> pd.DataFrame:
    """Which per-ticker verdicts and scores changed between two runs."""
    rows = []
    a0, a1 = before["analyze"].data, after["analyze"].data
    for t in a0.keys() & a1.keys():
        if a0[t]["ai_score"] != a1[t]["ai_score"] or a0[t]["ai_action"] != a1[t]["ai_action"]:
            rows.append({"ticker": t, "score": f"{a0[t]['ai_score']} -> {a1[t]['ai_score']}",
                         "action": f"{a0[t]['ai_action']} -> {a1[t]['ai_action']}"})
    if "holdfold" in before and "holdfold" in after:
        h0, h1 = before["holdfold"].data, after["holdfold"].data
        for t in h0.keys() & h1.keys():
            if h0[t]["verdict"] != h1[t]["verdict"]:
                rows.append({"ticker": t, "score": "", "action": f"holdfold {h0[t]['verdict']} -> {h1[t]['verdict']}"})
    return pd.DataFrame(rows, columns=["ticker", "score", "action"])
