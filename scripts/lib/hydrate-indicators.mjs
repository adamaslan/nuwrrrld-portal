/**
 * Indicator math for universe hydration, ported from
 * deploy/universe-hydration/modal_app.py.
 *
 * The Modal job is the authoritative implementation. Rows produced here and
 * rows produced there land in the same table and are compared directly, so
 * these functions must stay numerically identical to their Python
 * counterparts — including the pandas NaN-seeding conventions, which
 * __tests__/hydrate-indicators.test.ts pins against captured reference values.
 */

// Ported from deploy/universe-hydration/modal_app.py. The Modal job is the
// authoritative implementation; this file must stay numerically identical to
// it, because rows from both land in the same table and are compared directly.

/** Exponential moving average over the whole series, returned as a series. */
export function emaSeries(data, span) {
  const alpha = 2 / (span + 1);
  const out = [];
  let prev = data[0];
  out.push(prev);
  for (let i = 1; i < data.length; i++) {
    prev = data[i] * alpha + prev * (1 - alpha);
    out.push(prev);
  }
  return out;
}

/**
 * Wilder-smoothed EMA (alpha = 1/period), returning only the final value.
 *
 * `data` may start with nulls standing in for pandas' NaN — the Python side
 * builds these series with .diff(), whose first element is NaN, and pandas'
 * ewm() *seeds from the first non-NaN value* rather than treating it as zero.
 * Seeding from a synthetic 0 instead damps the average and drifts RSI/ADX
 * away from the Modal job's numbers, so the nulls are skipped here too.
 */
export function wilderLast(data, period) {
  const alpha = 1 / period;
  let prev = null;
  for (const v of data) {
    if (v === null || Number.isNaN(v)) continue;
    prev = prev === null ? v : v * alpha + prev * (1 - alpha);
  }
  return prev;
}

/** Wilder's RSI over a close series. null when there is not enough history. */
export function rsi(close, period = 14) {
  if (close.length < period + 1) return null;
  // Index 0 is null, matching pandas' close.diff() producing NaN there.
  const gains = [null];
  const losses = [null];
  for (let i = 1; i < close.length; i++) {
    const delta = close[i] - close[i - 1];
    gains.push(delta > 0 ? delta : 0);
    losses.push(delta < 0 ? -delta : 0);
  }
  const avgGain = wilderLast(gains, period);
  const avgLoss = wilderLast(losses, period);
  // No downside over the window: RSI is 100 by definition. Guarded explicitly
  // because the division below would otherwise yield Infinity/NaN.
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * "bullish"/"bearish" if the MACD line crossed its signal on the latest bar,
 * "missing" when there is not enough history, else null meaning *computed, no
 * cross* — a real observation the portal records as an explicit JSON null.
 */
export function macdCross(close, fast = 12, slow = 26, signal = 9) {
  if (close.length < slow + signal) return "missing";
  const emaFast = emaSeries(close, fast);
  const emaSlow = emaSeries(close, slow);
  const macd = emaFast.map((v, i) => v - emaSlow[i]);
  const sig = emaSeries(macd, signal);
  const diff = macd.map((v, i) => v - sig[i]);
  if (diff.length < 2) return "missing";
  const prev = diff.at(-2);
  const curr = diff.at(-1);
  if (prev <= 0 && curr > 0) return "bullish";
  if (prev >= 0 && curr < 0) return "bearish";
  return null;
}

/** Wilder's ADX. null when there is not enough history to stabilize. */
export function adx(high, low, close, period = 14) {
  if (close.length < period * 2) return null;

  // Bar 0 is real, not a hole, and mirrors the Python side exactly: np.where's
  // NaN comparisons collapse to false, so the DM seeds are 0.0; and TR's
  // Series.combine(max) drops the NaN branches fed by close.shift(), leaving
  // the plain high-low range. Both differ from RSI, where ewm skips a leading
  // NaN outright — hence the two conventions living side by side here.
  const plusDm = [0];
  const minusDm = [0];
  const tr = [high[0] - low[0]];
  for (let i = 1; i < close.length; i++) {
    const up = high[i] - high[i - 1];
    const down = -(low[i] - low[i - 1]);
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(
      Math.max(
        high[i] - low[i],
        Math.abs(high[i] - close[i - 1]),
        Math.abs(low[i] - close[i - 1])
      )
    );
  }

  // Running Wilder means over the three series, kept in step bar by bar so DX
  // can be formed from same-index values.
  const alpha = 1 / period;
  let atr = null,
    plusSm = null,
    minusSm = null;
  const dx = [];
  for (let i = 0; i < close.length; i++) {
    atr = atr === null ? tr[i] : tr[i] * alpha + atr * (1 - alpha);
    plusSm = plusSm === null ? plusDm[i] : plusDm[i] * alpha + plusSm * (1 - alpha);
    minusSm = minusSm === null ? minusDm[i] : minusDm[i] * alpha + minusSm * (1 - alpha);

    // atr === 0 mirrors the Python side's .replace(0, np.nan): an undefined
    // ratio is a hole in the series, not a zero reading.
    if (atr === 0) {
      dx.push(null);
      continue;
    }
    const plusDi = (100 * plusSm) / atr;
    const minusDi = (100 * minusSm) / atr;
    const denom = plusDi + minusDi;
    dx.push(denom === 0 ? null : (100 * Math.abs(plusDi - minusDi)) / denom);
  }

  const val = wilderLast(dx, period);
  return val === null || Number.isNaN(val) ? null : val;
}

/**
 * Where the latest realized volatility sits within its own trailing
 * distribution, 0-100. Percentile rather than absolute value because the
 * taxonomy buckets on regime, and "high for this name" is what regime means.
 */
export function volatilityPercentile(close, window = 20) {
  if (close.length < window * 2) return null;
  const returns = [];
  for (let i = 1; i < close.length; i++) {
    returns.push((close[i] - close[i - 1]) / close[i - 1]);
  }
  // Rolling sample standard deviation, matching pandas' default ddof=1.
  const realized = [];
  for (let i = window - 1; i < returns.length; i++) {
    const slice = returns.slice(i - window + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance =
      slice.reduce((a, b) => a + (b - mean) ** 2, 0) / (slice.length - 1);
    realized.push(Math.sqrt(variance));
  }
  if (!realized.length) return null;
  const latest = realized.at(-1);
  if (Number.isNaN(latest)) return null;
  return (realized.filter(v => v <= latest).length / realized.length) * 100;
}

/**
 * Agreement across the computed indicators, as a 0-100 score plus a direction.
 * Returns {score: null, direction: null} when nothing was computable.
 */
export function confluence(rsiVal, macdVal, adxVal) {
  const votes = [];
  if (rsiVal !== null) {
    votes.push(rsiVal <= 30 ? 1 : rsiVal >= 70 ? -1 : 0);
  }
  if (macdVal === "bullish") votes.push(1);
  else if (macdVal === "bearish") votes.push(-1);
  else if (macdVal === null) votes.push(0);

  if (!votes.length) return { score: null, direction: null };

  const net = votes.reduce((a, b) => a + b, 0);
  let agreement = Math.abs(net) / votes.length;
  // A trending tape makes agreement more meaningful; a ranging one less.
  if (adxVal !== null && adxVal >= 25) agreement = Math.min(1, agreement * 1.25);
  const score = Math.round(agreement * 100 * 10) / 10;
  const direction = net > 0 ? "bullish" : net < 0 ? "bearish" : "neutral";
  return { score, direction };
}

