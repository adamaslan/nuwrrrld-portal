"""Modal deployment of the full-universe hydration lane — coverage at zero AI cost.

The design (docs/max-coverage-simplest-path.md, docs/modal-vs-gcp-signal-coverage.md):
coverage is expensive only because the unit of coverage is an AI narrative. A
*token card* — the discretized tuple lib/grounding/taxonomy.ts already produces —
costs no model quota. So this job covers the whole universe every night for $0
in model spend, and the model is spent separately, on the top of the ranking
only, by deploy/precompute-ai/modal_app.py.

**This job never calls a model and holds no model key.** That is the invariant
worth protecting: if a future version imports an LLM client here, coverage stops
being free and the whole design collapses back into rationing.

Why Modal rather than the GCP backend: gcp3 is healthy and fast, but it computes
54 industry ETFs and has no per-stock path — `/signals?symbol=AAPL` returns
`{"error": "not found"}` with an HTTP 200. Per-stock indicators are new work
regardless of host, and this shape (pandas, fan-out, long timeouts, loud
failures) is what Modal is for. The two universes never overlap: gcp3 owns ETF
rows, this job owns stock rows, and `ticker_cards.source` keeps that legible.

Why it posts to the portal rather than writing Neon directly: validation,
idempotency, the replacement rule and CONFIG_ERROR behavior all stay in one
place. This container holds a push secret and a market-data key — never a
database URL, never a model key.

Deploy (one-time):
    pip install modal
    modal token new
    modal secret create nuwrrrld-hydration \\
        PORTAL_PUSH_SECRET=... \\
        PORTAL_URL=https://financial.nuwrrrld.com \\
        ALPACA_API_KEY=... \\
        ALPACA_API_SECRET=...
    modal deploy deploy/universe-hydration/modal_app.py

Run once manually (bypasses the cron):
    modal run deploy/universe-hydration/modal_app.py
    modal run deploy/universe-hydration/modal_app.py --symbols AAPL,MSFT,NVDA
"""

import os
from datetime import date, timedelta

import modal

app = modal.App("nuwrrrld-universe-hydration")

# pandas/numpy for the indicator math; httpx for the vendor fetch and the portal
# POST. No LLM client, deliberately — see the module docstring.
image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "httpx", "pandas", "numpy"
)

_SECRET = modal.Secret.from_name("nuwrrrld-hydration")

# Symbols per vendor request and per portal POST. The portal caps batches at 500
# rows; staying under it means a chunk failure costs one chunk, not the night.
CHUNK_SIZE = 200

# Trading days of history to pull. ADX needs ~2× its 14-period lookback to
# stabilize, and a long weekend plus a holiday can eat four sessions, so this is
# deliberately generous — the fetch is the cheap part.
LOOKBACK_DAYS = 120

HTTP_TIMEOUT_S = 120.0

# Coverage below this fails the run. A hydration job that "succeeds" while
# carding 12% of the universe is the silent-degradation failure this whole
# pipeline exists to prevent (docs/zo-free-tier-pipeline-synthesis.md).
MIN_COVERAGE_RATIO = 0.95


def _portal_base() -> str:
    return os.environ.get("PORTAL_URL", "https://financial.nuwrrrld.com").rstrip("/")


def _require(name: str) -> str:
    """Fetch a required secret, failing loudly rather than no-op'ing.

    A missing secret must be a configuration error, not a silent skip — the Zo
    pipeline's enrichment step self-skipped on a missing secret file for weeks
    while its briefings kept shipping green.
    """
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set in the nuwrrrld-hydration Modal secret; refusing to run"
        )
    return value


# ── Indicators ──────────────────────────────────────────────────────────────
# These are the *only* place per-stock indicator math lives. gcp3 computes ETF
# signals by a different method and is never asked about these symbols, so the
# two implementations cannot contend for one row. The taxonomy *buckets* are the
# contract, not the exact decimal — a float that drifts inside its bucket must
# not move the card.


def _rsi(close, period: int = 14) -> float | None:
    """Wilder's RSI over a close series. None when there is not enough history."""
    if len(close) < period + 1:
        return None
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    last_loss = loss.iloc[-1]
    if last_loss == 0:
        # No downside over the window: RSI is 100 by definition. Guarded
        # explicitly because the division below would otherwise yield inf/NaN.
        return 100.0
    rs = gain.iloc[-1] / last_loss
    return float(100 - (100 / (1 + rs)))


def _macd_cross(close, fast: int = 12, slow: int = 26, signal: int = 9):
    """Return 'bullish'/'bearish' if the MACD line crossed its signal on the
    latest bar, else None meaning *computed, no cross* — which is a real
    observation and is sent as an explicit JSON null.

    The distinction matters downstream: the portal counts an omitted key as a
    missing input, and an explicit null as a measured one.
    """
    if len(close) < slow + signal:
        return "missing"
    ema_fast = close.ewm(span=fast, adjust=False).mean()
    ema_slow = close.ewm(span=slow, adjust=False).mean()
    macd = ema_fast - ema_slow
    sig = macd.ewm(span=signal, adjust=False).mean()
    diff = macd - sig
    if len(diff) < 2:
        return "missing"
    prev, curr = diff.iloc[-2], diff.iloc[-1]
    if prev <= 0 < curr:
        return "bullish"
    if prev >= 0 > curr:
        return "bearish"
    return None


def _adx(high, low, close, period: int = 14) -> float | None:
    """Wilder's ADX. None when there is not enough history to stabilize."""
    import numpy as np

    if len(close) < period * 2:
        return None
    up = high.diff()
    down = -low.diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)

    tr = (
        (high - low)
        .combine((high - close.shift()).abs(), max)
        .combine((low - close.shift()).abs(), max)
    )
    atr = tr.ewm(alpha=1 / period, adjust=False).mean()
    atr_safe = atr.replace(0, np.nan)

    import pandas as pd

    plus_di = 100 * pd.Series(plus_dm, index=high.index).ewm(
        alpha=1 / period, adjust=False
    ).mean() / atr_safe
    minus_di = 100 * pd.Series(minus_dm, index=high.index).ewm(
        alpha=1 / period, adjust=False
    ).mean() / atr_safe

    denom = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / denom
    adx = dx.ewm(alpha=1 / period, adjust=False).mean().iloc[-1]
    return None if adx != adx else float(adx)  # NaN check without importing math


def _volatility_percentile(close, window: int = 20) -> float | None:
    """Where the latest realized volatility sits within its own trailing
    distribution, 0-100. Percentile rather than absolute value because the
    taxonomy buckets on regime, and 'high for this name' is what regime means."""
    if len(close) < window * 2:
        return None
    returns = close.pct_change()
    realized = returns.rolling(window).std()
    latest = realized.iloc[-1]
    if latest != latest:
        return None
    history = realized.dropna()
    if history.empty:
        return None
    return float((history <= latest).sum() / len(history) * 100)


def _confluence(rsi, macd_cross, adx, vol_pct) -> tuple[float | None, str | None]:
    """Agreement across the computed indicators, as a signed 0-100 score plus a
    direction. Returns (None, None) when nothing was computable.

    Kept simple on purpose: this feeds a *bucket* (weak/moderate/strong), so
    precision beyond the bucket boundary is wasted, and a more elaborate model
    here would be a second opinion competing with the portal's scorer.
    """
    votes = []
    if rsi is not None:
        if rsi <= 30:
            votes.append(1)
        elif rsi >= 70:
            votes.append(-1)
        else:
            votes.append(0)
    if macd_cross == "bullish":
        votes.append(1)
    elif macd_cross == "bearish":
        votes.append(-1)
    elif macd_cross is None:
        votes.append(0)

    if not votes:
        return None, None

    net = sum(votes)
    agreement = abs(net) / len(votes)
    # A trending tape makes agreement more meaningful; a ranging one less.
    if adx is not None and adx >= 25:
        agreement = min(1.0, agreement * 1.25)
    score = round(agreement * 100, 1)
    direction = "bullish" if net > 0 else "bearish" if net < 0 else "neutral"
    return score, direction


# ── Vendor fetch ────────────────────────────────────────────────────────────


def _fetch_bars(symbols: list[str], key: str, secret: str) -> dict:
    """Bulk daily bars from Alpaca. One request per chunk — Alpaca's multi-symbol
    bars endpoint has no per-day cap, which is why it is the right vendor for a
    nightly full-universe walk.

    Returns {symbol: DataFrame}. Symbols the vendor omits simply do not appear,
    and the caller reports them as per-row errors rather than failing the chunk.
    """
    import httpx
    import pandas as pd

    start = (date.today() - timedelta(days=LOOKBACK_DAYS)).isoformat()
    out: dict = {}
    page_token = None

    with httpx.Client(timeout=HTTP_TIMEOUT_S) as client:
        while True:
            params = {
                "symbols": ",".join(symbols),
                "timeframe": "1Day",
                "start": start,
                "limit": 10_000,
                "adjustment": "split",
            }
            if page_token:
                params["page_token"] = page_token
            resp = client.get(
                "https://data.alpaca.markets/v2/stocks/bars",
                params=params,
                headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
            )
            resp.raise_for_status()
            body = resp.json()
            for symbol, bars in (body.get("bars") or {}).items():
                frame = pd.DataFrame(bars)
                if symbol in out:
                    out[symbol] = pd.concat([out[symbol], frame], ignore_index=True)
                else:
                    out[symbol] = frame
            page_token = body.get("next_page_token")
            if not page_token:
                break

    return out


def _row_for(symbol: str, frame) -> dict:
    """Compute one symbol's indicator row. Never raises — an indicator failure
    becomes a per-row error so one bad symbol cannot poison 4,299 good ones."""
    try:
        if frame is None or len(frame) < 30:
            return {"ticker": symbol, "status": "error", "error": "insufficient history"}

        frame = frame.sort_values("t")
        close, high, low = frame["c"], frame["h"], frame["l"]

        rsi = _rsi(close)
        macd = _macd_cross(close)
        adx = _adx(high, low, close)
        vol = _volatility_percentile(close)
        conf, direction = _confluence(rsi, None if macd == "missing" else macd, adx, vol)

        row: dict = {
            "ticker": symbol,
            "status": "ok",
            "rsi": rsi,
            "adx": adx,
            "volatilityPercentile": vol,
            "confluenceScore": conf,
            "direction": direction,
        }
        # Only include the key when MACD was actually computed. An omitted key
        # tells the portal "not computed"; an explicit null tells it "computed,
        # no cross" — two different facts that must not collapse into one.
        if macd != "missing":
            row["macdCross"] = macd
        return row
    except Exception as exc:  # noqa: BLE001 — per-row isolation is the point
        return {"ticker": symbol, "status": "error", "error": f"{type(exc).__name__}: {exc}"}


def _post_chunk(rows: list[dict], run_id: str, bar_date: str) -> dict:
    """POST one chunk of rows to the portal. Raises on non-2xx so Modal's retry
    can take the chunk again — the portal upsert is idempotent, so a duplicate
    post is a no-op rather than a double-write."""
    import httpx

    secret = _require("PORTAL_PUSH_SECRET")
    with httpx.Client(timeout=HTTP_TIMEOUT_S) as client:
        resp = client.post(
            f"{_portal_base()}/api/pipeline/hydrate-universe",
            headers={"Authorization": f"Bearer {secret}"},
            json={
                "runId": run_id,
                "source": "modal-eod",
                "universe": "stock",
                "barDate": bar_date,
                "rows": rows,
            },
        )
        resp.raise_for_status()
        return resp.json()


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ── Scheduled entrypoint ────────────────────────────────────────────────────


@app.function(
    image=image,
    # 00:05 UTC — before the 00:10 precompute, so the AI batch ranks tonight's
    # cards rather than last night's. The ordering is the design: cards are free
    # and must exist before the one quota-bound step runs.
    schedule=modal.Cron("5 0 * * *"),
    secrets=[_SECRET],
    timeout=3600,
    retries=modal.Retries(max_retries=1, initial_delay=120.0),
)
def hydrate_universe_eod(symbols: list[str] | None = None) -> dict:
    """Walk the universe, compute indicators, post token cards to the portal."""
    import httpx

    key = _require("ALPACA_API_KEY")
    api_secret = _require("ALPACA_API_SECRET")
    _require("PORTAL_PUSH_SECRET")  # fail before doing vendor work, not after

    bar_date = date.today().isoformat()
    run_id = f"universe-eod:{bar_date}:modal"

    targets = symbols or _load_universe()
    if not targets:
        raise RuntimeError(
            "no active tickers to hydrate — is ticker_universe populated? "
            "Seed it with scripts/seed-universe.mjs before the first run."
        )

    print(f"[hydrate] run={run_id} symbols={len(targets)} chunk={CHUNK_SIZE}")

    totals = {"written": 0, "skipped": 0, "failed": 0, "upstream_errors": 0}
    last_coverage: dict = {}

    for index, chunk in enumerate(_chunks(targets, CHUNK_SIZE), start=1):
        try:
            bars = _fetch_bars(chunk, key, api_secret)
        except httpx.HTTPError as exc:
            # One chunk's vendor failure is not the run's failure: emit per-row
            # errors so the portal preserves each symbol's previous good card.
            print(f"[hydrate] chunk {index} vendor error: {exc}")
            bars = {}

        rows = [_row_for(symbol, bars.get(symbol)) for symbol in chunk]

        try:
            result = _post_chunk(rows, run_id, bar_date)
        except httpx.HTTPError as exc:
            print(f"[hydrate] chunk {index} POST failed: {exc}")
            totals["failed"] += len(chunk)
            continue

        totals["written"] += result.get("written", 0)
        totals["skipped"] += result.get("skipped", 0)
        totals["failed"] += result.get("failed", 0)
        totals["upstream_errors"] += len(result.get("upstreamErrors", []))
        last_coverage = result.get("coverage", {}) or last_coverage

        print(
            f"[hydrate] chunk {index}: written={result.get('written', 0)} "
            f"skipped={result.get('skipped', 0)} failed={result.get('failed', 0)}"
        )

    ratio = last_coverage.get("ratio", 0.0)
    print(
        f"[hydrate] done run={run_id} written={totals['written']} "
        f"skipped={totals['skipped']} failed={totals['failed']} "
        f"coverage={last_coverage.get('covered', 0)}/{last_coverage.get('active', 0)} "
        f"({ratio:.1%}) modelCalls=0"
    )

    if ratio < MIN_COVERAGE_RATIO:
        # Fail the run rather than reporting green on partial coverage. The
        # cards already written are still valid and still served; this exists so
        # a degraded night is visible in Modal's UI instead of silent.
        raise RuntimeError(
            f"coverage {ratio:.1%} is below the {MIN_COVERAGE_RATIO:.0%} floor "
            f"({last_coverage.get('covered', 0)}/{last_coverage.get('active', 0)} active symbols)"
        )

    return {**totals, "coverage": last_coverage, "modelCalls": 0}


def _load_universe() -> list[str]:
    """Active tickers from the portal. Read through the portal rather than the
    database for the same reason writes go through it — this container never
    holds a database URL."""
    import httpx

    secret = _require("PORTAL_PUSH_SECRET")
    with httpx.Client(timeout=HTTP_TIMEOUT_S) as client:
        resp = client.get(
            f"{_portal_base()}/api/pipeline/hydrate-universe",
            headers={"Authorization": f"Bearer {secret}"},
            params={"universe": "stock"},
        )
        resp.raise_for_status()
        return resp.json().get("tickers", [])


@app.local_entrypoint()
def main(symbols: str = "") -> None:
    """`modal run …` — optionally scoped to a comma-separated symbol list, which
    is how you smoke-test the whole path without walking 4,300 names."""
    parsed = [s.strip().upper() for s in symbols.split(",") if s.strip()] or None
    hydrate_universe_eod.remote(parsed)
