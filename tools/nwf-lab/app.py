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
    "backtest_hold_days": (1, 30, 1), "paper_buy_threshold": (55, 95, 5),
    "paper_sell_threshold": (5, 65, 5), "paper_max_position_weight": (0.01, 0.2, 0.005),
    "top_n": (3, 25, 1),
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
    "Hold/Fold": "**holdfold** starts from the technical score, nudges it by the share of analysts rating the stock "
                 "buy or better, and subtracts a small penalty for high beta. At or above *hold_score* it says HOLD, "
                 "below *fold_score* it says FOLD, in between WATCH. This rule is the lab's own, not the portal's.",
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
    "top_n": "How many tickers the leaderboard shows.",
}

FEATURE_DOC = {
    "brief": "market brief", "council": "four-analyst council views", "council-deliberate": "analyst debate",
    "council-public": "plain-language council summary", "council-sample": "sample council exchange",
    "nuai": "general trading-assistant answer", "signal-chat": "explanation of the top signal",
    "portfolio-health-ai": "explanation of portfolio health",
}


def intro(tab: str) -> None:
    st.markdown(TAB_INTRO[tab])



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


def acquire_bundle() -> DataBundle | None:
    st.sidebar.header("Data")
    source = st.sidebar.radio("Source", ["Fixture (synthetic)", "Live (Finnhub + Alpaca)", "Replay saved bundle"], help="Fixture: synthetic, no keys. Live: calls Finnhub and Alpaca. Replay: reload a saved bundle, zero API calls.")
    tickers = st.sidebar.multiselect("Tickers", sorted(set(DEFAULT_TICKERS) | {"TSLA", "AMZN", "GOOGL", "META"}),
                                     default=list(DEFAULT_TICKERS))
    extra = st.sidebar.text_input("More tickers (comma-separated)")
    tickers += [t.strip().upper() for t in extra.split(",") if t.strip()]
    csv = st.sidebar.file_uploader("Portfolio CSV (symbol,shares,cost_basis)", type="csv")
    positions = pd.read_csv(csv) if csv else None
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

    tabs = st.tabs(["Overview", "Data", "Signals", "Hold/Fold", "Backtest", "Portfolio", "Paper",
                    "News & earnings", "LLM"])
    with tabs[0]:
        intro("Overview")
        st.markdown(f"**{summary_line(results)}**")
        for g in working.gaps:
            st.warning(g)
        if working.manual_edits:
            st.caption("manual edits / scenario: " + ", ".join(working.manual_edits))
        st.plotly_chart(charts.status_grid(results), width="stretch")
    with tabs[1]:
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
    with tabs[2]:
        intro("Signals")
        if results["analyze"].status == "ok":
            sym = st.selectbox("Ticker", list(results["analyze"].frames))
            st.plotly_chart(charts.candles_with_bands(working, results, sym), width="stretch")
            st.plotly_chart(charts.leaderboard(results["signals-top"]), width="stretch")
            st.text(results["signals-digest"].data["text"])
        else:
            show_result(results["analyze"])
    with tabs[3]:
        intro("Hold/Fold")
        show_result(results["holdfold"])
        if results["holdfold"].status == "ok":
            st.dataframe(pd.DataFrame(results["holdfold"].data).T)
    with tabs[4]:
        intro("Backtest")
        if results["backtest"].status == "ok":
            st.plotly_chart(charts.backtest_equity(results["backtest"]), width="stretch")
            st.dataframe(pd.DataFrame(results["backtest"].data).T)
        else:
            show_result(results["backtest"])
    with tabs[5]:
        intro("Portfolio")
        for slug in ("portfolio-health", "portfolio-suggestions", "followed-tickers-read"):
            st.subheader(slug)
            show_result(results[slug])
        if results["portfolio-health"].status == "ok":
            st.plotly_chart(charts.sector_treemap(results["portfolio-health"]), width="stretch")
    with tabs[6]:
        intro("Paper")
        if results["paper-engine"].status == "ok":
            st.plotly_chart(charts.nav_curve(results["paper-engine"]), width="stretch")
            st.dataframe(results["paper-engine"].frames["orders"])
            st.json({k: v for k, v in results["paper-engine"].data.items()})
        else:
            show_result(results["paper-engine"])
    with tabs[7]:
        intro("News & earnings")
        for slug in ("news-sentiment", "earnings-watch", "insider-flow"):
            st.subheader(slug)
            show_result(results[slug])
    with tabs[8]:
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
