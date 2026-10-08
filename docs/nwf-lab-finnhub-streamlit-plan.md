# nwf-lab: one local Python script that runs every feature, plus Streamlit and Jupyter front ends

**Status:** proposal, 2026-10-07. Nothing has been built yet.
**Goal:** a single local Python package that:

1. pulls everything it needs from **Finnhub** (along with the one thing Finnhub's free tier can't provide; see §1),
2. runs **every data and analysis feature** the portal exposes, as pure Python functions, from one command, and
3. reuses those same functions in a **Streamlit app**, where you can change any input (tickers, thresholds, the fetched data itself) and see every feature recompute without making another API call.

---

## 1. Read this first: Finnhub alone can't feed every feature

On the free key, Finnhub rejects three things the signal features need:

| Need | Finnhub endpoint | Free tier? | Consequence |
|---|---|---|---|
| Daily OHLCV history (RSI, MACD, Bollinger, SMA, backtest, paper NAV) | `/stock/candle` | **No, it's premium (403)** | Bars have to come from somewhere else |
| News sentiment score | `/news-sentiment` | **No, premium** | Compute sentiment in-house from `/company-news` headlines |
| Social sentiment, price targets, upgrades and downgrades | `/stock/social-sentiment`, `/stock/price-target`, `/stock/upgrade-downgrade` | **No, premium** | Leave them out, or flag them as `vendor_gap` |

These limits come from `~/.claude/rules/market-data-fallback.md` (rewritten 2026-10-07), which also makes **Alpaca the primary source for bars**. The design below doesn't fight that. It puts every vendor behind one interface:

- **Finnhub** provides quotes, the company profile, basic financials and metrics, analyst recommendation trends, earnings history and calendar, insider transactions, peers, company news, general market news, and market status.
- **Alpaca bars** (`/v2/stocks/bars`, `feed=sip`, `adjustment=split`) provide daily OHLCV. The key pair is already in `.env.local`.
- **yfinance** is the bar fallback on the laptop only, logged at WARNING.
- A **fixture provider** replays a saved snapshot, so the app works offline and tests are deterministic.

If you really want Finnhub only, set `NWF_LAB_BARS=finnhub`. Every bar-dependent feature will then report `vendor_gap: candles 403` instead of returning a quiet wrong answer. That's the "make vendor gaps loud" rule.

Step 2 of §8 runs a probe script that confirms the free and premium status above against your own key. Trust its output over this table.

---

## 2. Which portal features map to which Python features

The source of truth is `docs/nulogdash-inventory.json`, the same inventory the nulogdash sweep uses. Each lab feature takes its **slug** from that file, so the two stay aligned.

### In scope: features that compute something from market data

| Lab slug | Portal route | Data it needs | Computes |
|---|---|---|---|
| `analyze` | `POST /api/analyze` | bars, quote, profile | RSI-14, MACD(12,26,9), Bollinger(20,2), SMA20/50, EMA20, volume ratio; direction and confidence, using the same voting logic as `homebase/locrun.py:analyze()` |
| `signals-live` | `GET /api/signals/live` | `analyze` output | per-ticker signal list (category and strength) |
| `signals-top` | `GET /api/signals/top` | `analyze` output for the universe | ranked leaderboard |
| `signals-digest` | `GET /api/signals/digest` | top, news | a short text digest |
| `signals-card` | `GET /api/signals/card` | analyze, profile | a share-card payload (JSON, with an optional PNG made by matplotlib) |
| `holdfold` | `GET /api/holdfold` | analyze, recommendation, metrics | HOLD or FOLD verdict and its reasons |
| `backtest` | `GET /api/backtest/:t` | bars | replays the signal rule over the history: hit rate, average return, max drawdown |
| `portfolio-health` | `GET /api/portfolio/health` | positions CSV, quotes, metrics, profile (sector) | concentration, sector spread, beta-weighted risk, a 0–100 score |
| `portfolio-suggestions` | `GET /api/portfolio/suggestions` | health output, peers | rebalance or swap suggestions |
| `followed-tickers-read` | `GET /api/followed-tickers` | analyze, past snapshots | a scoreboard comparing past calls with what happened |
| `paper-engine` | `/api/paper/*` (not yet in the inventory) | bars, quotes | a simulation of `lib/paper-engine.ts` policy: orders, positions, NAV curve |
| `news-sentiment` (new) | none | company-news | in-house lexicon or VADER score on headlines |
| `earnings-watch` (new) | none | calendar/earnings, earnings | upcoming dates and surprise history |
| `insider-flow` (new) | none | insider-transactions | net buying or selling over 90 days |

### Optional: these call an LLM rather than a market-data API

`brief`, `council`, `council-deliberate`, `council-public`, `council-sample`, `nuai`, `signal-chat`, `portfolio-health-ai`

Each of these builds its prompt from the in-scope outputs above, then calls OpenRouter (`OPENROUTER_API_KEY` is already in `.env.local`). They're **off by default** (`--with-llm` turns them on). With them off, the lab writes out the **prompt it would have sent**, so you can inspect and tune prompts in Streamlit without spending tokens.

### Out of scope: app plumbing with no market data

Watchlist CRUD, attribution, consent, legal-consent, disclaimer, feedback, privacy (DSAR), push, referral, retention, Stripe, health, signal drain and refresh status. These test the web app itself, and nulogdash already covers them. The lab lists them under `excluded` in its run summary, so "every feature" stays an accountable number instead of a vague claim.

---

## 3. Package layout

The proposed home is `tools/nwf-lab/` inside the portal repo. It sits next to the inventory it mirrors, and it's independent of the Next.js build.

```
tools/nwf-lab/
├── environment.yml              # mamba env: nwf-lab
├── pyproject.toml               # ruff + mypy + pytest config
├── run_all.py                   # CLI entry point: runs every feature
├── app.py                       # Streamlit entry point
├── nwf_lab/
│   ├── config.py                # frozen LabConfig (thresholds, windows, universe)
│   ├── errors.py                # VendorGapError, RateBudgetExceeded, ...
│   ├── data/
│   │   ├── providers.py         # MarketDataProvider Protocol
│   │   ├── finnhub.py           # FinnhubProvider (httpx + token bucket + cache)
│   │   ├── alpaca.py            # AlpacaBarsProvider
│   │   ├── yfinance_local.py    # laptop-only fallback
│   │   ├── fixture.py           # FixtureProvider (replays a snapshot)
│   │   ├── cache.py             # sqlite response cache, TTL per endpoint
│   │   └── bundle.py            # DataBundle: every input for a run, serializable
│   ├── features/
│   │   ├── registry.py          # @feature decorator + FEATURES dict
│   │   ├── analyze.py
│   │   ├── signals.py           # live / top / digest / card
│   │   ├── holdfold.py
│   │   ├── backtest.py
│   │   ├── portfolio.py         # health + suggestions
│   │   ├── paper.py
│   │   ├── news_sentiment.py
│   │   ├── earnings.py
│   │   ├── insider.py
│   │   └── llm.py               # prompt builders + optional OpenRouter call
│   └── report.py                # JSON + HTML summary of a run
├── fixtures/                    # saved DataBundles (gitignored except a tiny sample)
└── tests/
```

### The one design rule that makes Streamlit easy

**Fetching and computing are separate stages, and the only link between them is the `DataBundle`.**

```
providers ──fetch──▶ DataBundle (parquet/json on disk) ──compute──▶ FeatureResult per slug
                         ▲
                Streamlit edits this
```

- Feature functions are **pure**: `(bundle: DataBundle, cfg: LabConfig) -> FeatureResult`. They do no I/O and make no network calls.
- When you move a Streamlit slider, only `cfg` changes. When you edit a price in Streamlit, only the bundle changes. Neither one triggers a Finnhub call.
- `run_all.py` and `app.py` call the same registry, so the CLI and the app never drift apart.

---

## 4. Core code sketches

### 4.1 The provider interface

```python
# nwf_lab/data/providers.py
from typing import Protocol
import pandas as pd

class MarketDataProvider(Protocol):
    name: str
    def daily_bars(self, symbols: list[str], days: int) -> dict[str, pd.DataFrame]: ...
    def quotes(self, symbols: list[str]) -> dict[str, dict]: ...

class FundamentalsProvider(Protocol):
    def profile(self, symbol: str) -> dict: ...
    def metrics(self, symbol: str) -> dict: ...
    def recommendations(self, symbol: str) -> list[dict]: ...
    def earnings(self, symbol: str) -> list[dict]: ...
    def earnings_calendar(self, start: str, end: str) -> list[dict]: ...
    def insider_transactions(self, symbol: str) -> list[dict]: ...
    def peers(self, symbol: str) -> list[str]: ...
    def company_news(self, symbol: str, start: str, end: str) -> list[dict]: ...
```

`FinnhubProvider` implements `FundamentalsProvider` in full and implements `quotes()` from `MarketDataProvider`. Its `daily_bars()` raises `VendorGapError("finnhub", "candle", 403)`.

### 4.2 Finnhub client: paced, cached, and labeled with its source

```python
# nwf_lab/data/finnhub.py
FINNHUB_BASE_URL = "https://finnhub.io/api/v1"
FINNHUB_MIN_INTERVAL_S = 1.0       # rule: <=1 req/s; free plan is ~60/min
CACHE_TTL_S = {"quote": 60, "profile2": 7 * 86400, "stock/metric": 86400,
               "stock/recommendation": 86400, "company-news": 3600,
               "stock/earnings": 86400, "calendar/earnings": 21600,
               "stock/insider-transactions": 86400, "stock/peers": 7 * 86400}

class FinnhubProvider:
    name = "finnhub"

    def __init__(self, api_key: str, cache: ResponseCache, client: httpx.Client):
        self._key, self._cache, self._client = api_key, cache, client
        self._last_call = 0.0

    def _get(self, path: str, **params) -> Any:
        cached = self._cache.get(path, params)
        if cached is not None:
            return cached
        self._pace()
        # Finnhub accepts the token as a header, which keeps it out of logged URLs
        resp = self._client.get(f"{FINNHUB_BASE_URL}/{path}", params=params,
                                headers={"X-Finnhub-Token": self._key})
        if resp.status_code in (401, 403):
            raise VendorGapError("finnhub", path, resp.status_code)
        if resp.status_code == 429:
            raise RateBudgetExceeded("finnhub")
        resp.raise_for_status()
        data = resp.json()
        self._cache.put(path, params, data, ttl=CACHE_TTL_S.get(path, 3600))
        return data
```

Every value that ends up in a `DataBundle` records `{"source": "finnhub", "fetched_at": ...}`. Bars also record `feed`, either `sip` or `iex`.

### 4.3 Feature registry

```python
# nwf_lab/features/registry.py
@dataclass(frozen=True)
class FeatureSpec:
    slug: str                    # matches docs/nulogdash-inventory.json
    needs: tuple[str, ...]       # bundle fields, e.g. ("bars", "quote")
    depends_on: tuple[str, ...]  # other feature slugs
    fn: Callable[[DataBundle, LabConfig, dict], FeatureResult]
    llm: bool = False

FEATURES: dict[str, FeatureSpec] = {}

def feature(slug: str, needs=(), depends_on=(), llm=False):
    def wrap(fn):
        FEATURES[slug] = FeatureSpec(slug, tuple(needs), tuple(depends_on), fn, llm)
        return fn
    return wrap
```

```python
# nwf_lab/features/holdfold.py
@feature("holdfold", needs=("recommendations", "metrics"), depends_on=("analyze",))
def holdfold(bundle: DataBundle, cfg: LabConfig, upstream: dict) -> FeatureResult:
    ...
```

`run_all` sorts `FEATURES` topologically by `depends_on`. It runs each feature, catches `VendorGapError` **per feature** (one gap doesn't kill the run), and records each feature as `ok`, `vendor_gap`, `skipped_llm` or `error`.

### 4.4 `FeatureResult`

```python
@dataclass(frozen=True)
class FeatureResult:
    slug: str
    status: Literal["ok", "vendor_gap", "skipped_llm", "error"]
    data: dict                  # JSON-serializable payload
    frames: dict[str, pd.DataFrame] = field(default_factory=dict)  # for charts
    sources: tuple[str, ...] = ()
    note: str | None = None
```

---

## 5. The CLI: `run_all.py`

```
python run_all.py --tickers AAPL,NVDA,MSFT --portfolio fixtures/positions.csv
python run_all.py --universe watchlist --out runs/            # writes runs/<date>/
python run_all.py --from-bundle runs/2026-10-07/bundle.parquet  # offline replay, 0 API calls
python run_all.py --only analyze,backtest --with-llm
python run_all.py --probe                                     # endpoint free/premium check
```

Each run writes `runs/<YYYY-MM-DD>/`, containing:

- `bundle.parquet` and `bundle.meta.json`: every input, with its source
- `results.json`: one entry per slug, with status
- `summary.html`: a status grid plus key charts, made with the same Plotly figures the app uses
- an exit code of `0` when every in-scope feature is `ok`, `2` when there are vendor gaps, and `1` on errors

The run summary always prints counts like these: `14 in scope · 12 ok · 2 vendor_gap · 8 llm skipped · 23 excluded`.

**Rate budget:** a cold run costs about 9 Finnhub calls per ticker. At 1 request a second, 20 tickers take about 3 minutes cold and a few seconds warm (from cache). Alpaca bars cost one batched request per 150 symbols.

---

## 6. The Streamlit app: `app.py`

### Layout

- **Sidebar**
  - Data source: `Live (Finnhub + Alpaca)` · `Replay saved bundle` · `Upload bundle`
  - Tickers: a multiselect, which defaults to the watchlist
  - Portfolio: a CSV upload (`symbol,shares,cost_basis`)
  - Config: sliders for every `LabConfig` field: RSI window and the overbought and oversold levels, MACD spans, Bollinger window and σ, the bull/bear vote threshold, holdfold cutoffs, paper-engine entry and exit scores, and backtest holding days
  - Toggles for `Include LLM features` and `Show prompts only`
  - Buttons for **Fetch** (the only button that calls an API), **Save bundle**, and **Download results.json**
- **Tabs**
  - **Overview**: a feature status grid (one tile per slug) and a vendor-gap list
  - **Data**: `st.data_editor` on quotes, metrics and the latest bars, so you can overwrite a price or a metric and watch every downstream feature change. Edited cells are highlighted, and the bundle records `source: "manual"` for each one.
  - **Signals**: a candlestick chart with Bollinger and SMA overlays, RSI and MACD subplots, and the leaderboard
  - **Hold/Fold**: verdict cards with their reasons
  - **Backtest**: an equity curve, trade table and hit-rate figures
  - **Portfolio**: a health gauge, sector treemap, concentration bars and suggestions
  - **Paper**: NAV curve, orders and positions
  - **News and earnings**: a headline table with sentiment, the earnings calendar and insider flow
  - **LLM**: the prompt that would be sent, and the response if LLM features are on

### Caching, so that experimenting costs nothing

```python
@st.cache_data(ttl=3600, show_spinner="Fetching from Finnhub/Alpaca…")
def fetch_bundle(tickers: tuple[str, ...], days: int, as_of: str) -> DataBundle: ...

@st.cache_data
def compute_all(bundle_hash: str, cfg: LabConfig, _bundle: DataBundle) -> dict[str, FeatureResult]: ...
```

`LabConfig` is a frozen dataclass, so it hashes and works as a cache key. Moving a slider re-runs `compute_all` in milliseconds and never re-runs `fetch_bundle`.

### What-if presets

The sidebar has a "Scenario" selector that applies a transform to the bundle before compute:
`price shock −10%`, `volume ×2`, `drop last N days`, `earnings miss`. Each scenario is a pure function `DataBundle -> DataBundle` in `nwf_lab/scenarios.py`, so it's easy to add more.

---

## 7. Guardrails

- **Read-only.** The lab never writes to Neon, Firestore or the portal. If pushing results ever becomes useful, it gets its own explicit `--push` flag and goes through `lib/pipeline-db-guard.ts` semantics. Don't add it by default.
- **Never print secrets.** Keys come from `.env.local` through `python-dotenv`. Finnhub's token goes in the `X-Finnhub-Token` header, never in a logged URL. `bundle.meta.json` stores vendor names, not keys.
- **Paper only.** Alpaca is used for market data only. No code path imports an order endpoint.
- **Symbols.** Normalize `BRK-B` and `BRK.B` at the provider boundary. The portal's `normalizeToAlpaca` is the reference, and Finnhub uses the dot form.
- **Parity.** `tests/test_parity.py` runs `analyze` on a fixture and checks it against `homebase/locrun.py:analyze()` on the same bars. A drift between the two is a test failure.

---

## 8. Build steps (copy and paste)

**Step 1: Preflight.** Check that you're in the right repo and the keys are present (this prints names only).

```bash
cd ~/code/nuwrrrld-portal
grep -oE '^(FINNHUB_API_KEY|ALPACA_API_KEY|ALPACA_API_SECRET|OPENROUTER_API_KEY)=' .env.local
mamba --version
```
Expect four `NAME=` lines and a mamba version.

**Step 2: Probe Finnhub's free and premium status with your key.** This prints only endpoint names and HTTP codes.

```bash
cd ~/code/nuwrrrld-portal
set -a; source <(grep -E '^FINNHUB_API_KEY=' .env.local); set +a
for p in "quote?symbol=AAPL" "stock/profile2?symbol=AAPL" "stock/metric?symbol=AAPL&metric=all" \
         "stock/recommendation?symbol=AAPL" "stock/earnings?symbol=AAPL" \
         "calendar/earnings?from=$(date +%F)&to=$(date -v+14d +%F)" \
         "stock/insider-transactions?symbol=AAPL" "stock/peers?symbol=AAPL" \
         "company-news?symbol=AAPL&from=$(date -v-7d +%F)&to=$(date +%F)" \
         "stock/candle?symbol=AAPL&resolution=D&from=$(date -v-30d +%s)&to=$(date +%s)" \
         "news-sentiment?symbol=AAPL" "stock/price-target?symbol=AAPL"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "X-Finnhub-Token: $FINNHUB_API_KEY" "https://finnhub.io/api/v1/$p")
  echo "$code  ${p%%\?*}"; sleep 1.1
done
```
Expect `200` for the first nine and `403` for `stock/candle`, `news-sentiment` and `stock/price-target`. If any of them differ, update the table in §1.

**Step 3: Create the mamba env.** This installs everything in one solve, from conda-forge.

```bash
mamba create -y -n nwf-lab -c conda-forge python=3.11 \
  pandas=2.2 numpy=1.26 httpx python-dotenv pydantic tenacity pyarrow \
  streamlit plotly ta vaderSentiment yfinance pytest ruff mypy
```
Then verify it:
```bash
mamba run -n nwf-lab python -c "import streamlit, pandas, ta, httpx, plotly; print('ok', pandas.__version__)"
```
Expect `ok 2.2.x`.

**Step 4: Scaffold the package.**

```bash
cd ~/code/nuwrrrld-portal
mkdir -p tools/nwf-lab/{nwf_lab/data,nwf_lab/features,fixtures,tests,runs}
touch tools/nwf-lab/nwf_lab/__init__.py tools/nwf-lab/nwf_lab/data/__init__.py tools/nwf-lab/nwf_lab/features/__init__.py
printf 'runs/\nfixtures/*\n!fixtures/sample-*\n.cache/\n' > tools/nwf-lab/.gitignore
```

**Step 5: Build in this order.** Each stage is testable before the next one starts.

1. `data/cache.py`, `data/finnhub.py`, `data/alpaca.py`, `data/bundle.py`, plus `run_all.py --probe`
2. `features/registry.py` and `features/analyze.py`, plus the parity test against `locrun.py`
3. signals, holdfold, backtest, news_sentiment, earnings and insider
4. portfolio, paper
5. `app.py` (Overview, Data and Signals tabs first)
6. `features/llm.py` (prompts only first, the OpenRouter call second)

**Step 6: First full run, with a cold cache.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab python run_all.py --tickers AAPL,NVDA,MSFT --out runs/
```
Expect a summary line like `14 in scope · 14 ok · 0 vendor_gap · 8 llm skipped · 23 excluded`, with exit code `0`.

**Step 7: Offline replay.** Run this with Wi-Fi off. It should produce identical results and make 0 API calls.

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab python run_all.py --from-bundle "runs/$(date +%F)/bundle.parquet" --out runs/replay/
diff <(jq -S .results "runs/$(date +%F)/results.json") <(jq -S .results runs/replay/results.json) && echo IDENTICAL
```
Expect `IDENTICAL`.

**Step 8: Launch the app.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab streamlit run app.py
```
Expect it to open at `http://localhost:8501`. To check it, move the RSI-overbought slider: the Signals tab should update immediately, and the "API calls this session" counter in the sidebar should stay where it was.

**Step 9: Tests.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab pytest -q && mamba run -n nwf-lab ruff check . && mamba run -n nwf-lab mypy nwf_lab
```

---

## 9. A Jupyter notebook version

The notebook is a third front end to the same `nwf_lab` package, alongside `run_all.py` and `app.py`. It doesn't reimplement any features. It imports the registry, so a fix in `features/` shows up in the CLI, the app and the notebook at once.

The three front ends suit different jobs:

| | `run_all.py` | `app.py` (Streamlit) | `nwf_lab.ipynb` (Jupyter) |
|---|---|---|---|
| Best for | scheduled or repeatable runs | clicking through what-ifs | research: poking at intermediate frames, writing a new feature |
| What you change | CLI flags | sliders and a table editor | any Python object, directly |
| Output | `results.json` + HTML | a live page | cells, plus an optional export to HTML |

### Files

```
tools/nwf-lab/
├── notebooks/
│   ├── nwf_lab.py          # jupytext "percent" source: the one you commit and review
│   ├── nwf_lab.ipynb       # paired notebook, generated from the .py (gitignored)
│   └── feature_dev.py      # scratch template for building a new feature
```

Pair the notebook with **jupytext** so git tracks a plain `.py` file. A raw `.ipynb` diff is unreadable in review, and outputs can leak data such as tickers, positions and prompts. Keep `*.ipynb` gitignored, or strip its outputs with `nbstripout` if you want it committed.

### Cell outline (`notebooks/nwf_lab.py`)

```python
# %% [markdown]
# # nwf-lab: every feature, one notebook

# %% tags=["parameters"]
# papermill overrides these values
TICKERS = ["AAPL", "NVDA", "MSFT"]
DAYS = 365
FROM_BUNDLE = None          # e.g. "../runs/2026-10-07/bundle.parquet" for offline replay
WITH_LLM = False
PORTFOLIO_CSV = None

# %%
%load_ext autoreload
%autoreload 2               # edits in nwf_lab/ show up without a kernel restart
from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle, fetch_bundle
from nwf_lab.features.registry import FEATURES, run_features
from nwf_lab import scenarios, charts

# %% Fetch: the only cell that calls an API
bundle = DataBundle.load(FROM_BUNDLE) if FROM_BUNDLE else fetch_bundle(TICKERS, DAYS)
bundle.summary()            # rows per ticker, the source and fetched_at of each field, vendor gaps

# %% Compute every feature
cfg = LabConfig()
results = run_features(bundle, cfg, with_llm=WITH_LLM)
charts.status_grid(results)

# %% Inspect anything: these are plain DataFrames and dicts
results["analyze"].frames["AAPL"].tail()
results["holdfold"].data

# %% Manipulate: change config, data, or both, then recompute (0 API calls)
cfg2 = cfg.replace(rsi_overbought=65, bb_std=2.5)
shocked = scenarios.price_shock(bundle, pct=-0.10)
results2 = run_features(shocked, cfg2, with_llm=False)
charts.diff_table(results, results2)    # which verdicts and scores changed

# %% Interactive sliders (ipywidgets): Streamlit-style controls inside the notebook
from ipywidgets import interact, FloatSlider, IntSlider
@interact(rsi_ob=IntSlider(70, 55, 85), bb_std=FloatSlider(2.0, 1.0, 3.0, 0.1))
def _(rsi_ob, bb_std):
    r = run_features(bundle, cfg.replace(rsi_overbought=rsi_ob, bb_std=bb_std), only=["analyze", "signals-top"])
    return charts.leaderboard(r["signals-top"])

# %% Charts: the same Plotly figures the Streamlit app uses
charts.candles_with_bands(bundle, results, "NVDA")
charts.backtest_equity(results["backtest"])

# %% Save
bundle.save("../runs/notebook/bundle.parquet")
```

To make this possible, the package needs two small additions that the Streamlit app also benefits from:

- `nwf_lab/charts.py`: the Plotly figure builders, moved out of `app.py` so both front ends share them.
- `LabConfig.replace(**kw)`: a thin wrapper around `dataclasses.replace`, for one-line config edits.

### Parameterized runs with papermill

With the `parameters` cell tag, the notebook doubles as a batch job that keeps an executed copy of each run, outputs included:

```bash
papermill notebooks/nwf_lab.ipynb runs/$(date +%F)/nwf_lab.out.ipynb \
  -p TICKERS '["AAPL","TSLA"]' -p WITH_LLM False
```

### Notebook build steps (copy and paste)

**Step N1: Add the notebook packages to the env.**

```bash
mamba install -y -n nwf-lab -c conda-forge jupyterlab ipywidgets jupytext papermill nbstripout
```
Then verify:
```bash
mamba run -n nwf-lab python -c "import jupytext, papermill, ipywidgets; print('ok')"
```
Expect `ok`.

**Step N2: Register the env as a Jupyter kernel.**

```bash
mamba run -n nwf-lab python -m ipykernel install --user --name nwf-lab --display-name "Python (nwf-lab)"
jupyter kernelspec list 2>/dev/null | grep nwf-lab || mamba run -n nwf-lab jupyter kernelspec list | grep nwf-lab
```
Expect a line containing `nwf-lab`.

**Step N3: Create the paired notebook from the `.py` source and ignore the generated `.ipynb`.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mkdir -p notebooks
printf 'notebooks/*.ipynb\n' >> .gitignore
mamba run -n nwf-lab jupytext --set-formats ipynb,py:percent notebooks/nwf_lab.py
```
Expect `notebooks/nwf_lab.ipynb` to be created. After that, saving in either format updates the other.

**Step N4: Open it.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab jupyter lab notebooks/nwf_lab.ipynb
```
Choose the **Python (nwf-lab)** kernel, then run all cells. Expect the status grid to show the same counts as `run_all.py` in §8 step 6.

**Step N5: Check that it runs headless, offline, from a saved bundle.**

```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab papermill notebooks/nwf_lab.ipynb runs/replay/nwf_lab.out.ipynb \
  -p FROM_BUNDLE "../runs/$(date +%F)/bundle.parquet" && echo NOTEBOOK_OK
```
Expect `NOTEBOOK_OK`. This also makes a good CI smoke test, since it needs no API keys.

---

## 10. Open decisions

- **Where it lives.** It could be `tools/nwf-lab/` in the portal (proposed, next to the inventory) or `~/code/homebase/nwf-lab/`, next to `locrun.py`. The portal location wins if the inventory slugs are the contract. Homebase wins if this replaces `locrun.py`.
- **Replace `locrun.py`?** Once the parity test passes, `locrun.py` could become a thin wrapper around `nwf_lab`, with its Firestore and portal-push steps kept behind explicit flags. Per the archive rule, archive the old file rather than deleting it.
- **Paper engine fidelity.** A Python port of `lib/paper-engine.ts` will drift unless the policy constants are read from a shared JSON file that both sides load.
