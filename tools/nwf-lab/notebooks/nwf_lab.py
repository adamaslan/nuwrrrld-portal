# %% [markdown]
# # nwf-lab: every feature, one notebook
# Pair with jupytext: `jupytext --set-formats ipynb,py:percent notebooks/nwf_lab.py`

# %% tags=["parameters"]
# papermill overrides these values
TICKERS = ["AAPL", "NVDA", "MSFT"]
DAYS = 365
FROM_BUNDLE = None          # e.g. "../runs/2026-10-07/bundle.parquet" for offline replay
FIXTURE = False             # True = synthetic data, no keys
WITH_LLM = False
PORTFOLIO_CSV = None

# %%
import sys

sys.path.insert(0, "..")
from nwf_lab import charts, scenarios
from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.features.registry import run_features
from nwf_lab.pipeline import fetch_fixture, fetch_live, load_positions

# %% Fetch: the only cell that calls an API
cfg = LabConfig()
positions = load_positions(PORTFOLIO_CSV)
if FROM_BUNDLE:
    bundle = DataBundle.load(FROM_BUNDLE)
elif FIXTURE:
    bundle = fetch_fixture(TICKERS, DAYS, cfg, positions)
else:
    bundle = fetch_live(TICKERS, DAYS, cfg, positions)
bundle.summary()

# %% Compute every feature
results = run_features(bundle, cfg, with_llm=False)
charts.status_table(results)

# %% Inspect anything: plain DataFrames and dicts
first = TICKERS[0]
results["analyze"].frames[first].tail()

# %% Manipulate config and data, then recompute (0 API calls)
results2 = run_features(scenarios.price_shock(bundle, pct=-0.10), cfg.replace(rsi_overbought=65, bb_std=2.5))
charts.diff_table(results, results2)

# %% Charts: the same Plotly figures the Streamlit app uses
charts.candles_with_bands(bundle, results, first)

# %% Save
bundle.save("../runs/notebook/bundle.parquet")
