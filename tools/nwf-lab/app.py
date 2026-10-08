"""Streamlit front end. Only the Fetch button calls a vendor; sliders and edits recompute locally."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import streamlit as st

from nwf_lab import charts, scenarios
from nwf_lab.config import DEFAULT_TICKERS, Credentials, LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import LabError
from nwf_lab.features.llm import openrouter_caller
from nwf_lab.features.registry import FEATURES, FeatureResult, run_features
from nwf_lab.pipeline import fetch_fixture, fetch_live
from nwf_lab.report import summary_line

RUNS_DIR = Path(__file__).parent / "runs"
SLIDERS: dict[str, tuple[float, float, float]] = {
    "rsi_window": (5, 30, 1), "rsi_overbought": (55, 90, 1), "rsi_oversold": (10, 45, 1),
    "rsi_bull": (45, 70, 1), "rsi_bear": (30, 55, 1), "macd_fast": (5, 20, 1), "macd_slow": (15, 50, 1),
    "macd_signal": (3, 15, 1), "bb_window": (10, 40, 1), "bb_std": (1.0, 3.5, 0.1),
    "sma_fast": (5, 50, 1), "sma_slow": (20, 200, 5), "vol_surge": (1.0, 3.0, 0.05),
    "vol_dry": (0.3, 1.0, 0.05), "bull_vote_threshold": (1, 3, 1), "buy_score": (55, 95, 5),
    "sell_score": (5, 45, 5), "fold_score": (10, 60, 1), "hold_score": (40, 90, 1),
    "ichi_tenkan": (5, 20, 1), "ichi_kijun": (15, 60, 1), "ichi_senkou_b": (30, 120, 1),
    "ichi_cross_lookback": (1, 15, 1), "fib_lookback": (40, 250, 5), "fib_tolerance": (0.002, 0.03, 0.001),
    "backtest_hold_days": (1, 30, 1), "paper_buy_threshold": (55, 95, 5),
    "paper_sell_threshold": (5, 65, 5), "paper_max_position_weight": (0.01, 0.2, 0.005),
    "top_n": (3, 100, 1),
}

st.set_page_config(page_title="nwf-lab", layout="wide")

HOW_IT_WORKS = """
**nwf-lab runs the portal's analysis features on market data you control.**

1. **Fetch** (sidebar) is the *only* thing that calls a data vendor. It builds a **DataBundle**: daily price bars
   (Alpaca, or yfinance on this laptop), quotes + company data + news (Finnhub), and your portfolio CSV.
   Every value remembers which vendor it came from. *Fixture* uses synthetic data, so no keys are needed.
2. **Compute** turns that bundle into one result per feature. Features are pure functions: same bundle and
   same config in, same result out, no network.
3. **You change things, results recompute locally**: config sliders change the rules, the Data tab changes
   the inputs, a Scenario changes the market. None of these call a vendor. The *API calls* counter proves it.

A feature shows **ok**, **vendor_gap** (a vendor refused or has no data: reported loudly, never faked),
**skipped_input** (it needs something you did not provide, e.g. a portfolio CSV or an upstream feature),
**skipped_llm** (LLM features are off; the prompt is shown instead), or **error**.
"""

TAB_INTRO = {
    "Overview": "One row per feature with its status, the data sources it used, and why it was skipped if it was. "
                "Vendor gaps found while fetching are listed above the table.",
    "Data": "The raw inputs every feature reads. Edit a live price below and every signal, verdict and portfolio "
            "number recomputes (the edit is tagged source=manual). Nothing is sent anywhere.",
    "Signals": "**analyze** computes RSI, MACD, Bollinger bands and moving averages, then four indicator "
               "'votes' each for bullish and bearish decide the direction, a 0-100 score and BUY/HOLD/SELL. "
               "**signals-top** ranks tickers by score; **signals-digest** is the text summary.",
    "Universe": "Every ticker at once. The heatmap shows returns across 1D to 1Y (best and worst when there are "
                "many names), movers lists the extremes for one period, the histogram shows how the whole "
                "universe scores, and the comparison rebases prices to 100 so different stocks share one axis. "
                "Beyond a dozen tickers, lines become percentile bands plus the best and worst finishers.",
    "Hold/Fold": "**holdfold** starts from the technical score, nudges it by the share of analysts rating the stock "
                 "buy or better, and subtracts a small penalty for high beta. At or above *hold_score* it says HOLD, "
                 "below *fold_score* it says FOLD, in between WATCH. This rule is the lab's own, not the portal's.",
    "Ichimoku": "**ichimoku** scores four things +1/-1 each: price vs the cloud, Tenkan vs Kijun, cloud colour "
                "(span A vs B), and Chikou (today's close vs the close Kijun bars ago). Total 3 or more is "
                "strong bullish, -3 or less strong bearish. A recent Tenkan/Kijun cross is noted separately.",
    "Fibonacci": "**fib** finds the swing high and low in the lookback window, decides whether the dominant move "
                 "was up or down, and draws retracement levels (0.236 to 0.786) and extensions (1.272, 1.618). "
                 "Sitting on the 0.382/0.5/0.618 level is read as support in an uptrend or resistance in a downtrend; "
                 "breaking 0.786 means the swing is failing.",
    "Backtest": "**backtest** replays the same vote rule over each ticker's history: enter when the score reaches "
                "*buy_score*, hold *backtest_hold_days* bars, no overlapping trades. The curve is the compounded "
                "result; hit rate is the share of winning trades. Past results do not predict future ones.",
    "Portfolio": "Needs a positions CSV (symbol, shares, cost_basis). **portfolio-health** scores 0-100 from "
                 "concentration, single-name and sector weight, and weighted beta. **portfolio-suggestions** turns "
                 "the flags into trim/swap/diversify ideas. **followed-tickers-read** checks what the rule said "
                 "*backtest_hold_days* bars ago against what the price then did.",
    "Paper": "**paper-engine** simulates the 'quant' paper account: buy at the close when the score reaches "
             "*paper_buy_threshold*, sell below *paper_sell_threshold*, position size capped at "
             "*paper_max_position_weight* of NAV. A simplified replay, not the production engine.",
    "News & earnings": "**news-sentiment** scores each Finnhub headline with VADER (Finnhub's own sentiment is "
                       "premium). **earnings-watch** shows the next report date and past EPS surprises. "
                       "**insider-flow** nets insider open-market buys against sells over the lookback window.",
    "LLM": "These features build a prompt from the results above. They are off by default so no tokens are spent: "
           "you see the exact prompt that would be sent. Turn on *Include LLM features* (needs OPENROUTER_API_KEY) "
           "to get a real response.",
}

CONFIG_HELP = {
    "rsi_window": "Days used to compute RSI.", "rsi_overbought": "RSI above this reads as overbought (a bearish signal).",
    "rsi_oversold": "RSI below this reads as oversold.", "rsi_bull": "RSI above this casts a bullish vote.",
    "rsi_bear": "RSI below this casts a bearish vote.", "macd_fast": "Fast EMA span for MACD.",
    "macd_slow": "Slow EMA span for MACD.", "macd_signal": "Signal-line span for MACD.",
    "bb_window": "Bollinger band window in days.", "bb_std": "Bollinger band width in standard deviations.",
    "sma_fast": "Fast moving average; the price-vs-SMA vote uses it.", "sma_slow": "Slow moving average.",
    "vol_surge": "Volume / 20-day average above this casts a bullish vote.",
    "vol_dry": "Volume ratio below this casts a bearish vote.",
    "bull_vote_threshold": "Votes needed for a (weak) bullish or bearish call; 3 votes is always strong.",
    "buy_score": "Score at or above this is BUY.", "sell_score": "Score at or below this is SELL.",
    "fold_score": "holdfold score below this is FOLD.", "hold_score": "holdfold score at or above this is HOLD.",
    "backtest_hold_days": "Bars each backtest trade is held, and the lookback of the followed-tickers scoreboard.",
    "paper_buy_threshold": "Paper account buys at or above this score.",
    "paper_sell_threshold": "Paper account sells below this score.",
    "paper_max_position_weight": "Largest share of NAV in one paper position.",
    "ichi_tenkan": "Tenkan-sen (conversion line) window.", "ichi_kijun": "Kijun-sen (base line) window; also how far the cloud and Chikou are displaced.",
    "ichi_senkou_b": "Senkou span B window (the slow cloud edge).", "ichi_cross_lookback": "Bars back in which a Tenkan/Kijun cross still counts as recent.",
    "fib_lookback": "Bars searched for the swing high and low.", "fib_tolerance": "How close (fraction of price) counts as being 'at' a level.",
    "top_n": "How many tickers the leaderboard shows.",
}

FEATURE_DOC = {
    "brief": "market brief", "council": "four-analyst council views", "council-deliberate": "analyst debate",
    "council-public": "plain-language council summary", "council-sample": "sample council exchange",
    "nuai": "general trading-assistant answer", "signal-chat": "explanation of the top signal",
    "portfolio-health-ai": "explanation of portfolio health",
}


def show_symbol_tab(res: FeatureResult, chart) -> None:
    if res.status != "ok":
        st.info(f"{res.status}: {res.note or ''}")
        return
    summary = pd.DataFrame({t: {"bias": d["bias"], **({"score": d["score"]} if "score" in d else {"trend": d["trend"]})}
                            for t, d in res.data.items()}).T
    st.dataframe(summary)
    sym = st.selectbox("Ticker", list(res.data), key=f"sym_{res.slug}")
    st.plotly_chart(chart(sym), width="stretch")
    d = res.data[sym]
    st.write(d.get("reasons") or d.get("why"))
    if "levels" in d:
        st.dataframe(pd.Series(d["levels"], name="price"))


def intro(tab: str) -> None:
    st.markdown(TAB_INTRO[tab])



@st.cache_data(show_spinner="Building price panel…")
def cached_panel(bundle_hash: str, _bundle: DataBundle) -> pd.DataFrame:
    return charts.close_panel(_bundle)


@st.cache_data(show_spinner=False)
def cached_returns(bundle_hash: str, _panel: pd.DataFrame) -> pd.DataFrame:
    return charts.period_returns(_panel)


@st.cache_data(show_spinner="Computing features…")
def compute_all(bundle_hash: str, cfg: LabConfig, with_llm: bool, _bundle: DataBundle) -> dict[str, FeatureResult]:
    llm_call = None
    if with_llm:
        key = Credentials.from_env().openrouter
        llm_call = openrouter_caller(key) if key else None
    return run_features(_bundle, cfg, with_llm=with_llm and llm_call is not None, llm_call=llm_call)


def sidebar_config() -> LabConfig:
    base, values = LabConfig(), {}
    with st.sidebar.expander("Config (every field recomputes locally)", expanded=False):
        for name, (lo, hi, step) in SLIDERS.items():
            default = getattr(base, name)
            if isinstance(default, int):
                values[name] = st.slider(name, int(lo), int(hi), default, int(step), help=CONFIG_HELP[name])
            else:
                values[name] = st.slider(name, float(lo), float(hi), float(default), float(step), help=CONFIG_HELP[name])
    return base.replace(**values)


def read_dropped(files) -> tuple[list[str], pd.DataFrame | None, DataBundle | None, list[str]]:
    """Classify dropped files by content: tickers CSV, positions CSV, or a saved bundle (.parquet + .meta.json)."""
    import tempfile

    tickers: list[str] = []
    positions: pd.DataFrame | None = None
    bundle: DataBundle | None = None
    notes: list[str] = []
    by_name = {f.name: f for f in files}
    for f in files:
        if f.name.endswith(".csv"):
            df = pd.read_csv(f)
            cols = {c.strip().lower(): c for c in df.columns}
            if "shares" in cols and ("symbol" in cols or "ticker" in cols):
                df = df.rename(columns={cols.get("symbol", cols.get("ticker")): "symbol", cols["shares"]: "shares"})
                positions = df
                notes.append(f"{f.name}: {len(df)} portfolio positions")
            elif "ticker" in cols or "symbol" in cols:
                col = cols.get("ticker", cols.get("symbol"))
                tickers = list(dict.fromkeys(df[col].astype(str).str.strip().str.upper()))
                notes.append(f"{f.name}: {len(tickers)} tickers")
            else:
                notes.append(f"{f.name}: ignored (needs a 'ticker'/'symbol' column, plus 'shares' for positions)")
        elif f.name.endswith(".parquet"):
            meta = by_name.get(f.name[:-len(".parquet")] + ".meta.json")
            if meta is None:
                notes.append(f"{f.name}: also drop its {f.name[:-8]}.meta.json")
                continue
            tmp = Path(tempfile.mkdtemp())
            (tmp / f.name).write_bytes(f.getvalue())
            (tmp / meta.name).write_bytes(meta.getvalue())
            bundle = DataBundle.load(tmp / f.name)
            notes.append(f"{f.name}: saved bundle with {len(bundle.tickers)} tickers (no fetch needed)")
    return tickers, positions, bundle, notes


def acquire_bundle() -> DataBundle | None:
    st.markdown("##### Drag & drop")
    dropped = st.file_uploader(
        "Drop a tickers CSV (column `ticker`), a portfolio CSV (`symbol,shares,cost_basis`), or a saved bundle "
        "(`bundle.parquet` + `bundle.meta.json`). Several files at once is fine.",
        type=["csv", "parquet", "json"], accept_multiple_files=True)
    d_tickers, d_positions, d_bundle, d_notes = read_dropped(dropped or [])
    for n in d_notes:
        st.caption("✓ " + n)
    if d_bundle is not None:
        st.session_state["base"] = d_bundle

    st.sidebar.header("Data")
    source = st.sidebar.radio("Source", ["Fixture (synthetic)", "Live (Finnhub + Alpaca)", "Replay saved bundle"], help="Fixture: synthetic, no keys. Live: calls Finnhub and Alpaca. Replay: reload a saved bundle, zero API calls.")
    st.sidebar.caption("Tickers, portfolio and bundles: drag & drop on the main page.")
    tickers = st.sidebar.multiselect("Tickers", sorted(set(DEFAULT_TICKERS) | {"TSLA", "AMZN", "GOOGL", "META"}),
                                     default=list(DEFAULT_TICKERS))
    if d_tickers:
        tickers = d_tickers
    extra = st.sidebar.text_input("More tickers (comma-separated)")
    if len(tickers) > 20:
        st.sidebar.caption(f"{len(tickers)} tickers. Live fetch ≈ {9 * len(tickers)} Finnhub calls "
                           f"(~{9 * len(tickers) // 60} min cold at 1 req/s). Fixture is instant.")
    tickers += [t.strip().upper() for t in extra.split(",") if t.strip()]
    positions = d_positions
    days = st.sidebar.number_input("History (trading days)", 60, 1000, 365, 5)

    if source == "Replay saved bundle":
        found = sorted(RUNS_DIR.glob("*/bundle.parquet"))
        choice = st.sidebar.selectbox("Bundle", [str(p) for p in found]) if found else None
        if choice and st.sidebar.button("Load bundle"):
            st.session_state["base"] = DataBundle.load(choice)
    elif st.sidebar.button("Fetch", type="primary"):
        try:
            fetch = fetch_fixture if source.startswith("Fixture") else fetch_live
            st.session_state["base"] = fetch(tickers, int(days), LabConfig(), positions)
            st.session_state["api_calls"] = st.session_state.get("api_calls", 0) + int(
                st.session_state["base"].provenance.get("_api_calls", 0))
        except LabError as e:
            st.sidebar.error(str(e))
    st.sidebar.metric("API calls this session", st.session_state.get("api_calls", 0))
    return st.session_state.get("base")


def apply_edits(base: DataBundle, scenario: str) -> DataBundle:
    working = base.copy()
    for t, q in st.session_state.get("quote_edits", {}).items():
        if t in working.quotes:
            working.quotes[t]["price"] = q
            working.quotes[t]["source"] = "manual"
            working.manual_edits.append(f"quote:{t}")
    if scenario != "none":
        working = scenarios.SCENARIOS[scenario](working)
    return working


def show_result(res: FeatureResult) -> None:
    if res.status != "ok":
        st.info(f"{res.status}: {res.note or ''}")
        if "prompt" in res.data:
            st.code(res.data["prompt"])
        return
    st.json(res.data, expanded=False)


def main() -> None:
    st.title("nwf-lab")
    with st.expander("How this works", expanded="base" not in st.session_state):
        st.markdown(HOW_IT_WORKS)
    cfg = sidebar_config()
    base = acquire_bundle()
    if base is None:
        st.info("Pick a source in the sidebar and press Fetch (or Load bundle). Fixture needs no keys.")
        return
    scenario = st.sidebar.selectbox("Scenario", ["none", *scenarios.SCENARIOS], help="A what-if applied to a copy of the data before computing: a price shock, a volume spike, fewer days, or an earnings miss.")
    with_llm = st.sidebar.toggle("Include LLM features", value=False, help="Off: show prompts only (free). On: send them to OpenRouter.")
    working = apply_edits(base, scenario)
    results = compute_all(working.content_hash(), cfg, with_llm, working)

    st.sidebar.download_button("Download results.json", __import__("json").dumps(
        {s: {"status": r.status, "data": r.data} for s, r in results.items()}, default=str), "results.json")
    if st.sidebar.button("Save bundle"):
        RUNS_DIR.mkdir(exist_ok=True)
        st.sidebar.success(f"saved {working.save(RUNS_DIR / 'app' / 'bundle.parquet')}")

    names = ["Overview", "Data", "Signals", "Universe", "Ichimoku", "Fibonacci", "Hold/Fold", "Backtest",
             "Portfolio", "Paper", "News & earnings", "LLM"]
    tabs = dict(zip(names, st.tabs(names), strict=True))
    with tabs["Overview"]:
        intro("Overview")
        st.markdown(f"**{summary_line(results)}**")
        for g in working.gaps:
            st.warning(g)
        if working.manual_edits:
            st.caption("manual edits / scenario: " + ", ".join(working.manual_edits))
        st.plotly_chart(charts.status_grid(results), width="stretch")
    with tabs["Data"]:
        intro("Data")
        st.caption("Edit a live price; every feature recomputes. Edited rows are recorded as source=manual.")
        qdf = pd.DataFrame({"ticker": pd.Series(list(base.quotes), dtype="string"),
                            "price": pd.Series([float(q["price"]) for q in base.quotes.values()], dtype="float64")})
        if qdf.empty:
            st.info("No quotes in this bundle.")
        else:
            edited = st.data_editor(qdf, disabled=["ticker"], hide_index=True, key="quote_editor")
            st.session_state["quote_edits"] = {
                r.ticker: r.price for r in edited.itertuples()
                if abs(r.price - base.quotes[r.ticker]["price"]) > 1e-9}
        st.dataframe(working.summary(), hide_index=True)
    with tabs["Signals"]:
        intro("Signals")
        if results["analyze"].status == "ok":
            score_of = {t: d["ai_score"] for t, d in results["analyze"].data.items()}
            ranked = sorted(score_of, key=lambda t: (-score_of[t], t))  # best score first; type to search
            sym = st.selectbox("Ticker", ranked, format_func=lambda t: f"{t} ({score_of[t]})")
            c1, c2 = st.columns(2)
            period = c1.radio("Period", charts.CHART_PERIODS, index=4, horizontal=True, key="candle_period")
            freq = c2.radio("Bars", list(charts.FREQUENCIES), horizontal=True, key="candle_freq")
            st.plotly_chart(charts.candles_with_bands(working, results, sym, period, freq), width="stretch")
            st.plotly_chart(charts.leaderboard(results["signals-top"]), width="stretch")
            st.text(results["signals-digest"].data["text"])
        else:
            show_result(results["analyze"])
    with tabs["Universe"]:
        intro("Universe")
        panel = cached_panel(working.content_hash(), working)
        if panel.shape[1] < 2:
            st.info("Fetch at least two tickers with price history to compare them.")
        else:
            st.caption(f"{panel.shape[1]} tickers · {panel.index[0].date()} to {panel.index[-1].date()}")
            returns = cached_returns(working.content_hash(), panel)
            c1, c2, c3 = st.columns(3)
            sort_by = c1.radio("Sort by", charts.RETURN_PERIODS, index=2, horizontal=True, key="uni_sort")
            max_rows = c2.slider("Heatmap rows", 20, 1000, 60, 20, help="Past this many tickers the heatmap shows the best and worst half.")
            top_n = c3.slider("Movers per side", 5, 50, 15)
            st.subheader("Returns by period")
            st.plotly_chart(charts.returns_heatmap(returns, sort_by, max_rows), width="stretch")
            st.subheader(f"{sort_by} movers")
            st.plotly_chart(charts.movers(returns, sort_by, top_n), width="stretch")
            if results["analyze"].status == "ok":
                st.subheader("Score distribution")
                st.plotly_chart(charts.score_distribution(results["analyze"]), width="stretch")
            st.subheader("Price comparison (rebased to 100)")
            cmp_period = st.radio("Period", charts.CHART_PERIODS, index=2, horizontal=True, key="cmp_period")
            picked = st.multiselect("Tickers (empty = all)", list(panel.columns),
                                    help="Pick a few for one line each; leave empty to see the whole universe as bands.")
            sub = panel[picked] if picked else panel
            st.plotly_chart(charts.compare_rebased(sub, cmp_period), width="stretch")
    with tabs["Ichimoku"]:
        intro("Ichimoku")
        show_symbol_tab(results["ichimoku"], lambda sym: charts.ichimoku_chart(working, results["ichimoku"], sym))
    with tabs["Fibonacci"]:
        intro("Fibonacci")
        show_symbol_tab(results["fib"], lambda sym: charts.fib_chart(working, results["fib"], sym, cfg.fib_lookback))
    with tabs["Hold/Fold"]:
        intro("Hold/Fold")
        show_result(results["holdfold"])
        if results["holdfold"].status == "ok":
            st.dataframe(pd.DataFrame(results["holdfold"].data).T)
    with tabs["Backtest"]:
        intro("Backtest")
        if results["backtest"].status == "ok":
            bt_period = st.radio("Period", charts.CHART_PERIODS, index=5, horizontal=True, key="bt_period")
            st.plotly_chart(charts.backtest_equity(results["backtest"], period=bt_period), width="stretch")
            st.dataframe(pd.DataFrame(results["backtest"].data).T)
        else:
            show_result(results["backtest"])
    with tabs["Portfolio"]:
        intro("Portfolio")
        for slug in ("portfolio-health", "portfolio-suggestions", "followed-tickers-read"):
            st.subheader(slug)
            show_result(results[slug])
        if results["portfolio-health"].status == "ok":
            st.plotly_chart(charts.sector_treemap(results["portfolio-health"]), width="stretch")
    with tabs["Paper"]:
        intro("Paper")
        if results["paper-engine"].status == "ok":
            st.plotly_chart(charts.nav_curve(results["paper-engine"]), width="stretch")
            st.dataframe(results["paper-engine"].frames["orders"])
            st.json({k: v for k, v in results["paper-engine"].data.items()})
        else:
            show_result(results["paper-engine"])
    with tabs["News & earnings"]:
        intro("News & earnings")
        for slug in ("news-sentiment", "earnings-watch", "insider-flow"):
            st.subheader(slug)
            show_result(results[slug])
    with tabs["LLM"]:
        intro("LLM")
        for slug, spec in FEATURES.items():
            if spec.llm:
                with st.expander(f"{slug} — {FEATURE_DOC[slug]}"):
                    r = results[slug]
                    st.code(r.data.get("prompt", ""))
                    if "response" in r.data:
                        st.write(r.data["response"])
                    elif r.note:
                        st.caption(r.note)


main()
