"""Plotly/DataFrame builders shared by summary.html, the Streamlit app and the notebook."""
from __future__ import annotations

import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import FeatureResult

STATUS_COLOR = {
    "ok": "#2e7d32", "vendor_gap": "#ef6c00", "skipped_llm": "#9e9e9e",
    "skipped_input": "#78909c", "error": "#c62828",
}


# Calendar-based lookbacks so a period means the same thing for returns, candles and equity curves.
PERIOD_OFFSETS: dict[str, pd.DateOffset] = {
    "1D": pd.DateOffset(days=1), "1W": pd.DateOffset(weeks=1), "1M": pd.DateOffset(months=1),
    "3M": pd.DateOffset(months=3), "6M": pd.DateOffset(months=6), "1Y": pd.DateOffset(years=1),
}
RETURN_PERIODS = ("1D", "1W", "1M", "3M", "6M", "YTD", "1Y")
CHART_PERIODS = ("1M", "3M", "6M", "YTD", "1Y", "All")
FREQUENCIES = {"Daily": None, "Weekly": "W-FRI", "Monthly": "ME"}
FAN_LINE_LIMIT = 12   # above this many series, draw percentile bands + outliers instead of one line each
HEATMAP_ROW_PX = 18
BAR_ROW_PX = 18


def period_start(end: pd.Timestamp, period: str) -> pd.Timestamp | None:
    """First date a period covers, or None for the whole history."""
    if period == "All":
        return None
    if period == "YTD":
        return pd.Timestamp(year=end.year, month=1, day=1)
    return end - PERIOD_OFFSETS[period]


def slice_period(df: pd.DataFrame, period: str) -> pd.DataFrame:
    if df.empty:
        return df
    start = period_start(df.index[-1], period)
    return df if start is None else df.loc[df.index >= start]


def close_panel(bundle: DataBundle, symbols: list[str] | None = None) -> pd.DataFrame:
    """dates x symbols closes. Built once per bundle; every multi-ticker chart reads it."""
    syms = [s for s in (symbols or bundle.tickers) if s in bundle.bars and not bundle.bars[s].empty]
    if not syms:
        return pd.DataFrame()
    return pd.concat({s: bundle.bars[s]["close"] for s in syms}, axis=1).sort_index()


def period_returns(panel: pd.DataFrame, periods: tuple[str, ...] = RETURN_PERIODS) -> pd.DataFrame:
    """Percent return per ticker per period (rows = tickers). NaN where history is too short."""
    if panel.empty:
        return pd.DataFrame(columns=list(periods))
    filled = panel.ffill()
    end, last = filled.index[-1], filled.iloc[-1]
    out = {}
    for period in periods:
        start = period_start(end, period)
        pos = filled.index.searchsorted(start, side="right") - 1
        # Not enough history to look back that far (or the start predates the panel): no value.
        out[period] = (last / filled.iloc[pos] - 1) * 100 if pos >= 0 else pd.Series(np.nan, index=panel.columns)
    return pd.DataFrame(out)


def rebased_panel(panel: pd.DataFrame, period: str, base: float = 100.0) -> pd.DataFrame:
    """Slice to a period and rebase each ticker to `base` at its first price in that window."""
    sliced = slice_period(panel.ffill(), period).dropna(axis=1, how="all")
    if sliced.empty:
        return sliced
    return sliced / sliced.bfill().iloc[0] * base


def _empty_figure(message: str, height: int = 240) -> go.Figure:
    fig = go.Figure()
    fig.add_annotation(text=message, showarrow=False, font=dict(size=14, color="#78909c"))
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    fig.update_layout(height=height, margin=dict(l=0, r=0, t=20, b=0))
    return fig


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


def candles_with_bands(
    bundle: DataBundle, results: dict[str, FeatureResult], symbol: str,
    period: str = "1Y", freq: str = "Daily",
) -> go.Figure:
    """Candles + bands for one ticker. Indicators are computed on full history, then sliced and resampled."""
    df = bundle.bars[symbol]
    fr = results["analyze"].frames[symbol]
    rule = FREQUENCIES[freq]
    if rule:
        df = df.resample(rule).agg({"open": "first", "high": "max", "low": "min", "close": "last",
                                    "volume": "sum"}).dropna(subset=["close"])
        fr = fr.resample(rule).last().dropna(how="all")
    df, fr = slice_period(df, period), slice_period(fr, period)
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
    fig.update_layout(height=640, xaxis_rangeslider_visible=False, margin=dict(l=0, r=0, t=20, b=0),
                      title=dict(text=f"{symbol} · {period} · {freq.lower()}", font=dict(size=13)))
    return fig


def fan_chart(panel: pd.DataFrame, *, y_title: str, highlight: int = 5, height: int = 420,
              baseline: float | None = None) -> go.Figure:
    """Many series on one axis without spaghetti: 10-90 and 25-75 percentile bands, the median,
    and only the `highlight` best and worst finishers drawn as lines."""
    panel = panel.dropna(axis=1, how="all")
    if panel.empty:
        return _empty_figure("no series to plot")
    final = panel.ffill().iloc[-1].sort_values()
    q = panel.quantile([0.10, 0.25, 0.5, 0.75, 0.90], axis=1)
    x = panel.index
    fig = go.Figure()
    for lo, hi, name, color in ((0.10, 0.90, "10-90th pct", "rgba(120,144,156,0.18)"),
                                (0.25, 0.75, "25-75th pct", "rgba(120,144,156,0.32)")):
        fig.add_trace(go.Scatter(x=x, y=q.loc[hi], mode="lines", line=dict(width=0), showlegend=False,
                                 hoverinfo="skip"))
        fig.add_trace(go.Scatter(x=x, y=q.loc[lo], mode="lines", line=dict(width=0), fill="tonexty",
                                 fillcolor=color, name=name, hoverinfo="skip"))
    fig.add_trace(go.Scatter(x=x, y=q.loc[0.5], name=f"median of {panel.shape[1]}",
                             line=dict(width=2, color="#37474f")))
    for sym in final.index[-highlight:][::-1]:
        fig.add_trace(go.Scattergl(x=x, y=panel[sym], name=f"{sym} (best)", line=dict(width=1.2, color="#2e7d32")))
    for sym in final.index[:highlight]:
        fig.add_trace(go.Scattergl(x=x, y=panel[sym], name=f"{sym} (worst)", line=dict(width=1.2, color="#c62828")))
    if baseline is not None:
        fig.add_hline(y=baseline, line=dict(width=1, dash="dot", color="#90a4ae"))
    fig.update_layout(height=height, yaxis_title=y_title, hovermode="x unified",
                      margin=dict(l=0, r=0, t=20, b=0))
    return fig


def compare_rebased(panel: pd.DataFrame, period: str = "6M", highlight: int = 5) -> go.Figure:
    """Rebased-to-100 price comparison. Up to FAN_LINE_LIMIT tickers get a line each; beyond that, a fan."""
    reb = rebased_panel(panel, period)
    if reb.empty:
        return _empty_figure("no price history in this period")
    if reb.shape[1] > FAN_LINE_LIMIT:
        return fan_chart(reb, y_title=f"rebased to 100 ({period})", highlight=highlight, baseline=100)
    fig = go.Figure()
    for sym in reb:
        fig.add_trace(go.Scattergl(x=reb.index, y=reb[sym], name=sym, line=dict(width=1.4)))
    fig.add_hline(y=100, line=dict(width=1, dash="dot", color="#90a4ae"))
    fig.update_layout(height=420, yaxis_title=f"rebased to 100 ({period})", hovermode="x unified",
                      margin=dict(l=0, r=0, t=20, b=0))
    return fig


def returns_heatmap(returns: pd.DataFrame, sort_by: str = "1M", max_rows: int | None = 60) -> go.Figure:
    """Tickers x periods. Past `max_rows`, shows the best half and worst half so 1000 names stay legible."""
    df = returns.dropna(how="all")
    if df.empty:
        return _empty_figure("no returns to show")
    df = df.sort_values(sort_by, ascending=False, na_position="last")
    total, title = len(df), None
    if max_rows and total > max_rows:
        half = max_rows // 2
        df = pd.concat([df.head(half), df.tail(half)])
        title = f"{half} best and {half} worst by {sort_by} of {total} tickers"
    bound = float(np.nanpercentile(np.abs(df.to_numpy(dtype=float)), 95)) or 1.0  # clip outliers so colors stay readable
    fig = go.Figure(go.Heatmap(
        z=df.to_numpy(dtype=float), x=list(df.columns), y=list(df.index), zmin=-bound, zmax=bound, zmid=0,
        colorscale="RdYlGn", colorbar=dict(title="%", thickness=12),
        text=df.to_numpy(dtype=float) if len(df) <= 60 else None,
        texttemplate="%{text:.1f}" if len(df) <= 60 else None,
        hovertemplate="%{y} · %{x}: %{z:.2f}%<extra></extra>", xgap=1, ygap=1 if len(df) <= 120 else 0,
    ))
    fig.update_yaxes(autorange="reversed", type="category", tickfont=dict(size=10),
                     dtick=1 if len(df) <= 80 else None)
    fig.update_xaxes(side="top")
    fig.update_layout(height=max(240, HEATMAP_ROW_PX * len(df) + 80), margin=dict(l=0, r=0, t=40, b=0),
                      title=dict(text=title, font=dict(size=12)) if title else None)
    return fig


def movers(returns: pd.DataFrame, period: str = "1M", n: int = 15) -> go.Figure:
    """The n best and n worst tickers for one period as horizontal bars."""
    col = returns[period].dropna().sort_values()
    if col.empty:
        return _empty_figure(f"no {period} returns")
    picked = pd.concat([col.head(n), col.tail(n)]).loc[lambda s: ~s.index.duplicated()]
    fig = go.Figure(go.Bar(
        x=picked.values, y=picked.index, orientation="h",
        marker_color=["#2e7d32" if v >= 0 else "#c62828" for v in picked.values],
        hovertemplate="%{y}: %{x:.2f}%<extra></extra>"))
    fig.update_yaxes(type="category", tickfont=dict(size=10))
    fig.update_layout(height=max(240, BAR_ROW_PX * len(picked) + 60), xaxis_title=f"{period} return (%)",
                      margin=dict(l=0, r=0, t=20, b=0))
    return fig


def score_distribution(result: FeatureResult) -> go.Figure:
    """How the whole universe scores, split by action: the shape, not 1000 individual bars."""
    data = result.data
    if not data:
        return _empty_figure("no scores")
    df = pd.DataFrame(data).T[["ai_score", "ai_action"]]
    colors = {"BUY": "#2e7d32", "HOLD": "#78909c", "SELL": "#c62828"}
    fig = go.Figure()
    for action, g in df.groupby("ai_action"):
        fig.add_trace(go.Histogram(x=g["ai_score"].astype(float), name=f"{action} ({len(g)})",
                                   marker_color=colors.get(str(action), "#90a4ae"), xbins=dict(size=12.5)))
    fig.update_layout(barmode="stack", height=300, xaxis_title="ai_score", yaxis_title="tickers",
                      margin=dict(l=0, r=0, t=20, b=0))
    return fig


def equity_panel(result: FeatureResult, symbol: str | None = None) -> pd.DataFrame:
    """dates x tickers of equity (x), forward-filled between trades; 1.0 before a ticker's first trade."""
    series = {sym: tdf.set_index("exit_date")["equity"] for sym, tdf in result.frames.items()
              if (not symbol or sym == symbol) and not tdf.empty}
    if not series:
        return pd.DataFrame()
    return pd.concat(series, axis=1).sort_index().ffill().fillna(1.0)


def backtest_equity(result: FeatureResult, symbol: str | None = None, period: str = "All",
                    highlight: int = 5) -> go.Figure:
    panel = equity_panel(result, symbol)
    if panel.empty:
        return _empty_figure("no backtest trades")
    panel = slice_period(panel, period)
    if panel.empty:
        return _empty_figure(f"no trades in {period}")
    panel = panel / panel.iloc[0]  # rebase so every period starts at 1.0x
    if panel.shape[1] > FAN_LINE_LIMIT:
        return fan_chart(panel, y_title=f"equity (x), {period}", highlight=highlight, baseline=1.0)
    fig = go.Figure()
    for sym in panel:
        fig.add_trace(go.Scatter(x=panel.index, y=panel[sym], name=sym, mode="lines+markers"))
    fig.update_layout(height=360, yaxis_title="equity (x)", margin=dict(l=0, r=0, t=20, b=0))
    return fig


def leaderboard(result: FeatureResult) -> go.Figure:
    df = result.frames["ranked"]
    if len(df) <= 25:
        fig = go.Figure(go.Bar(x=df["ticker"], y=df["ai_score"], text=df["ai_action"]))
        fig.update_layout(height=320, yaxis_title="ai_score", margin=dict(l=0, r=0, t=20, b=0))
        return fig
    fig = go.Figure(go.Bar(x=df["ai_score"], y=df["ticker"], text=df["ai_action"], orientation="h"))
    fig.update_yaxes(autorange="reversed", type="category", tickfont=dict(size=10))
    fig.update_layout(height=BAR_ROW_PX * len(df) + 60, xaxis_title="ai_score", margin=dict(l=0, r=0, t=20, b=0))
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


def ichimoku_chart(bundle: DataBundle, result: FeatureResult, symbol: str) -> go.Figure:
    fr, df = result.frames[symbol], bundle.bars[symbol]
    fig = go.Figure(go.Candlestick(x=df.index, open=df.open, high=df.high, low=df.low, close=df.close, name=symbol))
    for col, color in (("tenkan", "#e53935"), ("kijun", "#1e88e5")):
        fig.add_trace(go.Scatter(x=fr.index, y=fr[col], name=col, line=dict(width=1, color=color)))
    fig.add_trace(go.Scatter(x=fr.index, y=fr["span_a"], name="span A", line=dict(width=0.5, color="#43a047")))
    fig.add_trace(go.Scatter(x=fr.index, y=fr["span_b"], name="span B", line=dict(width=0.5, color="#c62828"),
                             fill="tonexty", fillcolor="rgba(150,150,150,0.2)"))
    fig.update_layout(height=520, xaxis_rangeslider_visible=False, margin=dict(l=0, r=0, t=20, b=0))
    return fig


def fib_chart(bundle: DataBundle, result: FeatureResult, symbol: str, lookback: int = 120) -> go.Figure:
    df, info = bundle.bars[symbol].iloc[-lookback:], result.data[symbol]
    fig = go.Figure(go.Candlestick(x=df.index, open=df.open, high=df.high, low=df.low, close=df.close, name=symbol))
    for name, price in info["levels"].items():
        fig.add_hline(y=price, line_dash="dot", line_width=1, annotation_text=name, annotation_position="right")
    fig.update_layout(height=520, xaxis_rangeslider_visible=False, margin=dict(l=0, r=60, t=20, b=0))
    return fig
