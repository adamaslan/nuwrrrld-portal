# nwf-lab

One local Python package that runs every portal data/analysis feature as a pure function, with three front ends
(CLI, Streamlit, Jupyter). Design: [`docs/nwf-lab-finnhub-streamlit-plan.md`](../../docs/nwf-lab-finnhub-streamlit-plan.md).

Fetching and computing are separate: `providers → DataBundle → pure features`. Only `fetch_*` touches a vendor.

## Run it

**1. Env (once).**
```bash
mamba env create -f ~/code/nuwrrrld-portal/tools/nwf-lab/environment.yml
```

**2. No-keys smoke run (synthetic data).** Expect `14 in scope · 14 ok · … · 8 llm skipped`.
```bash
cd ~/code/nuwrrrld-portal/tools/nwf-lab
mamba run -n nwf-lab python run_all.py --fixture --portfolio fixtures/sample-positions.csv --out runs/
```

**3. Probe your Finnhub key** (names and HTTP codes only). Expect 200 for the first nine, 403 for candle, news-sentiment, price-target.
```bash
mamba run -n nwf-lab python run_all.py --probe
```

**4. Live run** (Finnhub fundamentals + Alpaca SIP bars; yfinance bar fallback on this laptop only).
```bash
mamba run -n nwf-lab python run_all.py --tickers AAPL,NVDA,MSFT --portfolio fixtures/sample-positions.csv --out runs/
```

**5. Offline replay** (0 API calls). Expect `IDENTICAL`.
```bash
D=runs/$(date +%F)
mamba run -n nwf-lab python run_all.py --from-bundle $D/bundle.parquet --out runs/replay/
diff <(jq -S .results $D/results.json) <(jq -S .results runs/replay/results.json) && echo IDENTICAL
```

**6. Streamlit.** Opens at http://localhost:8501. Pick *Fixture*, press **Fetch**, move a config slider: the "API calls this session" counter must not change.
```bash
mamba run -n nwf-lab streamlit run app.py
```

**7. Tests + lint.**
```bash
mamba run -n nwf-lab pytest -q && mamba run -n nwf-lab ruff check . && mamba run -n nwf-lab mypy nwf_lab
```

## Exit codes
`0` all in-scope features ok (or skipped for missing input) · `2` at least one `vendor_gap` · `1` a feature errored or bad usage.

## Notes
- `NWF_LAB_BARS=finnhub` forces Finnhub-only bars: every bar-dependent feature reports `vendor_gap` (candles are premium).
- LLM features are off by default; the result carries the exact prompt. `--with-llm` needs `OPENROUTER_API_KEY`.
- Read-only: nothing writes to Neon/Firestore/the portal. Alpaca is used for market data only.
