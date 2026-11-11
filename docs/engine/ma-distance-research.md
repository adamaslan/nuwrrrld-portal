# MA-distance context: offline executable first slice

`se1.trend.ma_distance_atr` version `1.0.0-research` is a local, point-in-time research calculation. It does not add a live Signals card, change a confluence score, claim an edge, or activate a detector. Its output explicitly carries `promoted:false`, `confluenceWeight:0` and `basisIndependentlyVerified:false`.

## Run on an already-held local snapshot

```sh
npx tsx scripts/replay-ma-distance.ts /absolute/path/local-bars.json 2026-11-10
npx tsx scripts/replay-ma-distance.ts /absolute/path/local-bars.json --replay
```

The first form produces one dossier. The second recomputes every daily prefix, including explicit insufficient-history and withheld results. Stdout is JSON. Neither command fetches prices, connects a DB, invokes a model, writes an artifact, or promotes anything. Redirect stdout to a private local file if desired. Do not put proprietary input snapshots in the repository.

Input shape:

```json
{
  "symbol": "TEST",
  "source": "describe the actual local snapshot and provider here",
  "priceBasis": "split-adjusted-ohlc",
  "bars": [
    {"date":"2026-09-01","open":100,"high":101,"low":99,"close":100,"volume":1000}
  ]
}
```

This one-row example intentionally returns `insufficient_history`. Supply at least 50 completed daily bars, ascending by unique real date. `asOf` is the latest allowed completed session date, not a request time. Only bars on/before it enter the formula and input hash. The caller must ensure those bars really were available then. Retrospectively adjusted prices and today's universe do not establish a survivorship-free point-in-time backtest.

`priceBasis` is a caller declaration, not a certificate. Raw/unknown basis is withheld. If adjustment basis is not independently known, use `unknown`. Split-adjusted close with unadjusted open/high/low is not a valid input for this formula. The code cannot detect every mislabeled split or provider restatement, so a passing calculation never proves price correctness.

## Exact formula and evidence

- `SMA50`: arithmetic mean of the last 50 closes, including the completed evaluation bar.
- `ATR14`: true range `max(high-low, abs(high-previousClose), abs(low-previousClose))`, first true range `high-low`, Wilder recursive smoothing with alpha `1/14`, seeded at that first range. The entire supplied prefix sets the seed history. Use the same frozen history when comparing implementations.
- `distanceAtr = (close-SMA50)/ATR14`; also return `distancePercent = (close/SMA50-1)*100` for comparison.
- A signed distance is context: above/below the average, not a BUY/SELL prediction. No untested extreme threshold or inferred win probability is added.
- Invalid/nonfinite/nonpositive OHLC, negative volume, malformed/duplicate/unordered dates, zero ATR, stale latest bars and gaps over seven calendar days are rejected or withheld. Seven days is a bounded research guard, not an exchange calendar.
- Result includes scan/version, symbol, declared source/basis, evaluation date, bars used and a SHA256 over the versioned input prefix. It excludes future prices from that hash. No source declaration is independently authenticated.

Existing signals-app `MADistanceExpandedDetector` at `d9cb9738dead78ea8e318f566ff6790d2590045b` uses percentage thresholds across SMA windows. It is **not** the same as this ATR-unit context. This implementation reuses portal `buildFrame`/WilderATR14 and `smaSeries` instead of claiming a name match proves parity.

Source: https://raw.githubusercontent.com/adamaslan/signals-app/d9cb9738dead78ea8e318f566ff6790d2590045b/src/signals_app/detection/trend.py

## Checks and remaining work

`npx vitest run __tests__/ma-distance-dossier.test.ts` covers a hand-calculated linear fixture, warmup, neutral zero distance, all-prefix equivalence, future-price mutation, malformed history, raw/unknown basis, gaps/staleness, zero ATR, source hashing and non-mutation. Fixtures are synthetic, not real SOXX/ITA or trading performance. CLI execution and an independent Python arithmetic comparison are separate validation receipts.

Still open: verified real snapshot/source basis, same-input comparison with other conventions, chronological outcome/holdout evaluation, readable stored result and digest/UI wiring, volume confirmation, budget/shadow/promotion gates and independent review. No production feed/DB writes or result-store integration is hidden in this slice. It is one implemented research question, not 500 active scans or 500 independent votes.
