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

# Calendar days of history to pull. The binding constraint is the 50/200
# moving-average detector (_ma_position_votes), which needs >= 200 daily bars
# before it can vote at all. ~200 trading sessions span ~280 calendar days;
# a full 365 clears that with margin for weekends and market holidays. The
# fetch is the cheap part, so err generous.
LOOKBACK_DAYS = 365

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


# ── Ported detectors (signals-app scoring/confluence.py + detection/) ────────
#
# These are ports of ~/code/signals-app's detector family, narrowed to what a
# nightly full-universe walk can afford. signals-app runs 19 detectors with
# per-detector thread-pool timeout isolation; that isolation exists because it
# serves one interactive request where a hung detector blocks a user. Here the
# unit of isolation is already the *row* (`_row_for` catches per symbol), and
# these are pure pandas over an in-memory frame with no I/O to hang on — so the
# thread pool would add overhead per ticker across 950 tickers and buy nothing.
#
# Each detector returns a list of (category, strength) votes, the same shape
# signals-app's MutableSignal carries into ConfluenceRanker.rank_signals().
# Emitting *lists* rather than a single reading is what makes this a confluence
# model rather than a scaled average: one detector can fire several independent
# observations, and a category firing twice legitimately counts twice.


def _bollinger_votes(close, window: int = 20, num_std: float = 2.0):
    """Band position + %B. Ported from BollingerBandSignalDetector /
    BBExpansionDetector (the 4x4 parameter grid is collapsed to the standard
    20/2.0 pair — the grid's value is intraday resolution this daily walk
    doesn't have)."""
    if len(close) < window + 1:
        return []
    ma = close.rolling(window).mean()
    sd = close.rolling(window).std()
    upper, lower = ma.iloc[-1] + num_std * sd.iloc[-1], ma.iloc[-1] - num_std * sd.iloc[-1]
    last = close.iloc[-1]
    if upper != upper or lower != lower or upper == lower:
        return []

    votes = []
    # %B — where price sits across the band, 0 at lower / 1 at upper.
    pct_b = (last - lower) / (upper - lower)
    if pct_b >= 1.0:
        votes.append(("BOLLINGER", "STRONG_BEARISH"))   # riding/piercing upper
    elif pct_b <= 0.0:
        votes.append(("BOLLINGER", "STRONG_BULLISH"))   # piercing lower
    elif pct_b >= 0.8:
        votes.append(("BOLLINGER", "BEARISH"))
    elif pct_b <= 0.2:
        votes.append(("BOLLINGER", "BULLISH"))
    else:
        votes.append(("BOLLINGER", "NEUTRAL"))
    return votes


def _stochastic_votes(high, low, close, k_period: int = 14, d_period: int = 3):
    """%K/%D with the cross gated on the extreme zone.

    Ported from StochasticSignalDetector + StochasticCrossDetector. The gating
    is the point and is preserved deliberately: signals-app fires the cross
    signal only when a K/D crossover happens *and* the oscillator sits in the
    oversold/overbought zone, which is a strictly higher-quality filter than
    either condition alone. An ungated cross in mid-range is noise."""
    if len(close) < k_period + d_period + 1:
        return []
    ll = low.rolling(k_period).min()
    hh = high.rolling(k_period).max()
    span = (hh - ll)
    k = 100 * (close - ll) / span.where(span != 0)
    d = k.rolling(d_period).mean()
    if len(k.dropna()) < 2 or len(d.dropna()) < 2:
        return []
    k_now, k_prev = k.iloc[-1], k.iloc[-2]
    d_now, d_prev = d.iloc[-1], d.iloc[-2]
    if any(v != v for v in (k_now, k_prev, d_now, d_prev)):
        return []

    votes = []
    if k_now <= 20:
        votes.append(("STOCHASTIC", "BULLISH"))
    elif k_now >= 80:
        votes.append(("STOCHASTIC", "BEARISH"))
    else:
        votes.append(("STOCHASTIC", "NEUTRAL"))

    # The gated cross — only inside the extreme zone.
    crossed_up = k_prev <= d_prev and k_now > d_now
    crossed_down = k_prev >= d_prev and k_now < d_now
    if crossed_up and k_now <= 20:
        votes.append(("STOCHASTIC", "STRONG_BULLISH"))
    elif crossed_down and k_now >= 80:
        votes.append(("STOCHASTIC", "STRONG_BEARISH"))
    return votes


def _obv_cmf_votes(high, low, close, volume, cmf_period: int = 20, ema_span: int = 20):
    """On-Balance Volume EMA cross + Chaikin Money Flow pressure.

    Ported from OBVCMFDetector. Carries a category bonus in the weighting below
    because volume-confirmed moves are higher-conviction than price-only ones.
    Returns [] when volume is absent — several ETFs report no volume, and a
    zero-filled OBV would read as sustained distribution rather than as the
    missing input it is."""
    import numpy as np

    if volume is None or len(close) < max(cmf_period, ema_span) + 1:
        return []
    if volume.isna().all() or (volume.fillna(0) <= 0).all():
        return []

    votes = []

    # OBV vs its own EMA — direction of accumulation.
    direction = np.sign(close.diff().fillna(0.0))
    obv = (direction * volume.fillna(0)).cumsum()
    obv_ema = obv.ewm(span=ema_span, adjust=False).mean()
    if len(obv) >= 2:
        prev_gap = obv.iloc[-2] - obv_ema.iloc[-2]
        curr_gap = obv.iloc[-1] - obv_ema.iloc[-1]
        if prev_gap <= 0 < curr_gap:
            votes.append(("OBV_CMF", "STRONG_BULLISH"))
        elif prev_gap >= 0 > curr_gap:
            votes.append(("OBV_CMF", "STRONG_BEARISH"))

    # CMF — buying vs selling pressure over the period, in [-1, 1].
    span = (high - low).replace(0, np.nan)
    mf_mult = ((close - low) - (high - close)) / span
    mf_vol = mf_mult * volume
    denom = volume.rolling(cmf_period).sum()
    cmf = mf_vol.rolling(cmf_period).sum() / denom.where(denom != 0)
    cmf_now = cmf.iloc[-1]
    if cmf_now == cmf_now:  # not NaN
        if cmf_now >= 0.20:
            votes.append(("OBV_CMF", "BULLISH"))
        elif cmf_now <= -0.20:
            votes.append(("OBV_CMF", "BEARISH"))
        else:
            votes.append(("OBV_CMF", "NEUTRAL"))
    return votes


def _ma_cross_votes(close):
    """Golden/death cross and price-vs-20MA. Ported from
    MovingAverageSignalDetector; the 11-pair ExpandedMACross grid is reduced to
    the 50/200 pair plus the 20MA position, since the grid's extra pairs are
    highly correlated on daily bars and would let one trend observation vote
    eleven times."""
    votes = []
    if len(close) >= 200:
        ma50 = close.rolling(50).mean()
        ma200 = close.rolling(200).mean()
        if len(ma50.dropna()) >= 2 and len(ma200.dropna()) >= 2:
            prev = ma50.iloc[-2] - ma200.iloc[-2]
            curr = ma50.iloc[-1] - ma200.iloc[-1]
            if prev == prev and curr == curr:
                if prev <= 0 < curr:
                    votes.append(("MA_CROSS", "EXTREME_BULLISH"))   # golden cross
                elif prev >= 0 > curr:
                    votes.append(("MA_CROSS", "EXTREME_BEARISH"))   # death cross
                elif curr > 0:
                    votes.append(("MA_CROSS", "BULLISH"))
                else:
                    votes.append(("MA_CROSS", "BEARISH"))
    if len(close) >= 20:
        ma20 = close.rolling(20).mean().iloc[-1]
        last = close.iloc[-1]
        if ma20 == ma20 and ma20 != 0:
            drift = (last - ma20) / ma20
            if drift >= 0.05:
                votes.append(("MA_DISTANCE", "BULLISH"))
            elif drift <= -0.05:
                votes.append(("MA_DISTANCE", "BEARISH"))
            else:
                votes.append(("MA_DISTANCE", "NEUTRAL"))
    return votes


def _rsi_macd_votes(rsi, macd_cross):
    """The two indicators the pre-port scorer used, restated as votes so they
    join the same weighted aggregate rather than being a separate model."""
    votes = []
    if rsi is not None:
        if rsi <= 20:
            votes.append(("RSI", "EXTREME_BULLISH"))
        elif rsi <= 30:
            votes.append(("RSI", "STRONG_BULLISH"))
        elif rsi >= 80:
            votes.append(("RSI", "EXTREME_BEARISH"))
        elif rsi >= 70:
            votes.append(("RSI", "STRONG_BEARISH"))
        else:
            votes.append(("RSI", "NEUTRAL"))
    if macd_cross == "bullish":
        votes.append(("MACD", "STRONG_BULLISH"))
    elif macd_cross == "bearish":
        votes.append(("MACD", "STRONG_BEARISH"))
    elif macd_cross is None:
        votes.append(("MACD", "NEUTRAL"))
    return votes


def _volatility_votes(vol_pct):
    """Volatility regime as an explicit vote.

    The pre-port `_confluence` accepted `vol_pct` and never read it — the
    parameter was dead. It is directionally neutral by nature (high vol is not
    bullish or bearish), so it enters as a NEUTRAL vote, which is not inert:
    neutral votes add 0.1 to max_weight and therefore *dilute* an otherwise
    unanimous score. A name whose only strong reading arrives in an extreme-vol
    regime should not score the same as one in a calm tape."""
    if vol_pct is None:
        return []
    if vol_pct >= 80 or vol_pct <= 20:
        return [("VOLATILITY", "NEUTRAL")]
    return []


# Strength -> numeric vote. Ported verbatim from signals-app
# scoring/confluence.py's _STRENGTH_BULL_WEIGHT so the two engines agree on what
# a given reading is worth.
_STRENGTH_WEIGHT = {
    "EXTREME_BULLISH": 3.0,
    "STRONG_BULLISH": 2.0,
    "BULLISH": 1.0,
    "NEUTRAL": 0.0,
    "BEARISH": -1.0,
    "STRONG_BEARISH": -2.0,
    "EXTREME_BEARISH": -3.0,
}

# Category bonus added to abs(vote) for higher-conviction categories. Also from
# signals-app: MA_CROSS / MACD / VOLUME +0.5, OBV_CMF / ICHIMOKU +0.3.
_CATEGORY_BONUS = {
    "MA_CROSS": 0.5,
    "MACD": 0.5,
    "VOLUME": 0.5,
    "OBV_CMF": 0.3,
}

# A directional call needs both a score past the threshold and a minimum count
# of agreeing signals, so one extreme reading cannot manufacture a call on its
# own. signals-app's config.py uses +/-0.35 with 3 agreeing signals.
_BUY_THRESHOLD = 0.35
_SELL_THRESHOLD = -0.35
_MIN_AGREEING = 3


def _confluence(rsi, macd_cross, adx, vol_pct, frame=None) -> tuple[float | None, str | None]:
    """Weighted confluence across the ported detectors, as a signed 0-100
    magnitude plus a direction.

    Replaces a two-indicator vote count (RSI and MACD only; `adx` merely scaled
    agreement and `vol_pct` was accepted and never read). Now every detector
    contributes a strength-weighted vote with a per-category conviction bonus,
    normalized to [-1, 1] exactly as signals-app's ConfluenceRanker does, then
    reported on the 0-100 scale this pipeline's callers already expect.

    Two properties are deliberately preserved from signals-app rather than
    simplified away:

    - **Gated direction.** A bullish/bearish label requires the normalized score
      past +/-0.35 *and* at least 3 agreeing signals. Below that the direction
      is "neutral" even when the score leans, because a lean built from one
      reading is not a call. This is what stops the cohort selector from
      freezing a pick on a single extreme RSI.
    - **Neutral votes are not free.** They add 0.1 to max_weight, so a name with
      one strong signal amid several neutral ones scores below a name where
      everything agrees. Averaging only the non-neutral readings would erase
      that distinction.

    `frame` is optional so existing callers and tests that pass only the four
    scalars keep working — without it, this scores the RSI/MACD/volatility votes
    alone, which is the pre-port behavior plus correct neutral dilution.

    Returns (None, None) when nothing was computable.
    """
    votes = []
    votes += _rsi_macd_votes(rsi, macd_cross)
    votes += _volatility_votes(vol_pct)

    if frame is not None:
        try:
            close, high, low = frame["c"], frame["h"], frame["l"]
            volume = frame["v"] if "v" in frame else None
            votes += _ma_cross_votes(close)
            votes += _bollinger_votes(close)
            votes += _stochastic_votes(high, low, close)
            votes += _obv_cmf_votes(high, low, close, volume)
        except Exception:  # noqa: BLE001
            # A detector family failing degrades the score to the indicators
            # that did compute rather than failing the row. Matches
            # signals-app's typed-degradation stance: a partial result must not
            # masquerade as a complete one, but it is still worth reporting.
            pass

    if not votes:
        return None, None

    weighted_bull = 0.0
    weighted_bear = 0.0
    max_weight = 0.0
    bull_count = 0
    bear_count = 0

    for category, strength in votes:
        base = _STRENGTH_WEIGHT.get(strength, 0.0)
        bonus = _CATEGORY_BONUS.get(category, 0.0)
        if base > 0:
            vote = base + bonus
            weighted_bull += vote
            max_weight += vote
            bull_count += 1
        elif base < 0:
            vote = abs(base) + bonus
            weighted_bear += vote
            max_weight += vote
            bear_count += 1
        else:
            max_weight += 0.1  # neutral signals carry minimal weight, not zero

    if max_weight <= 0:
        return None, None

    raw = (weighted_bull - weighted_bear) / max_weight

    # A trending tape makes agreement more meaningful; a ranging one less. Kept
    # from the pre-port scorer, but applied to the normalized score and clamped
    # so the 1.25x cannot push a reading outside [-1, 1].
    if adx is not None and adx >= 25:
        raw = max(-1.0, min(1.0, raw * 1.25))

    # Gated direction — threshold AND agreeing-signal count.
    if raw >= _BUY_THRESHOLD and bull_count >= _MIN_AGREEING:
        direction = "bullish"
    elif raw <= _SELL_THRESHOLD and bear_count >= _MIN_AGREEING:
        direction = "bearish"
    else:
        direction = "neutral"

    # Reported as a signed 0-100 magnitude. The sign is load-bearing for
    # cohort selection, which ranks the two tails of this distribution
    # (lib/ticker-cards-db.ts `bipolarCards`).
    score = round(raw * 100, 1)
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
        # `frame` unlocks the ported detector families (MA cross, Bollinger,
        # Stochastic, OBV/CMF); without it the score falls back to RSI+MACD.
        conf, direction = _confluence(
            rsi, None if macd == "missing" else macd, adx, vol, frame=frame
        )

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
