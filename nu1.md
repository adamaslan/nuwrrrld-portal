# Track-record / backtest feature — status update

Branch: `worktree-agent-a8bb18a8b9a5dad53` (worktree off `main`, based on `fb71d68`)

## Goal
Add a minimal track-record/backtest display to the portal, sourced from the
**separate** `signals-app` FastAPI backend's `GET /backtest/{symbol}` endpoint
(historical hit-rate data). This is a different engine than the `gcp3`
backend the portal's live signal digest currently consumes — the two are not
otherwise connected.

## Research completed
- Confirmed `SignalPayload` shape in `lib/digest.ts` (`score`, `reasons`,
  `signalCounts`, `isStale`, `engineVersion` already exist).
- Confirmed `SignalsClient.tsx` rendering patterns to reuse: `.signal-score`,
  `.signal-reasons`, `.signal-detail` CSS classes in
  `app/dashboard/signals/signals.css`.
- Confirmed the env-var + fallback pattern used for `MCP_BACKEND_URL` in
  `app/api/signals/digest/route.ts` and `app/dashboard/signals/page.tsx`
  (8s AbortController timeout, return `null` on failure — never throw).
- Read-only confirmed exact response shape of `GET /backtest/{symbol}` in
  `~/code/signals-app/src/signals_app/api/routes.py` (lines ~260-341):
  ```json
  {
    "symbol": "AAPL",
    "period": "2y",
    "horizon_days": 5,
    "bars_scanned": 412,
    "by_category": [{"key": "...", "hits": 97, "total": 142, "hit_rate": 0.6831}],
    "by_strength": [{"key": "...", "hits": 0, "total": 0, "hit_rate": 0.0}]
  }
  ```
- Confirmed Next.js 16 dynamic route param pattern (`params: Promise<{...}>`,
  await it) from `app/api/portfolio/watchlist/[ticker]/route.ts`.

## Done
- `lib/backtest.ts` — server-side fetch helper. Mirrors the `MCP_BACKEND_URL`
  pattern exactly: `SIGNALS_ENGINE_URL` env var, default `""` (disabled), 8s
  timeout via AbortController, returns `null` on any failure (never throws).
  Exports `BacktestResult` / `BacktestBucket` types and `fetchBacktest(symbol)`.

## Not yet done (next steps)
1. `app/api/backtest/[symbol]/route.ts` — thin proxy route that calls
   `fetchBacktest` and returns JSON (or a `{ error }` 503-style response when
   disabled/unavailable), following the same shape as
   `app/api/signals/digest/route.ts`.
2. A reusable `TrackRecordBadge` component (e.g.
   `components/TrackRecordBadge.tsx`) — client component, lazily fetches
   `/api/backtest/{ticker}` on demand (not on page load for every card, to
   avoid N backtest calls per digest render) and renders something like
   "Historical hit-rate: 68% (n=142)" using the existing `.signal-score`
   class, matched against the signal's category/strength bucket.
3. Wire the badge into `SignalsClient.tsx`'s expanded card detail section
   (near the existing `sig.score` / `sig.signalCounts` block, ~line 171-182
   of `app/dashboard/signals/SignalsClient.tsx`), OR ship it as a
   standalone opt-in element if wiring into every card is too much scope —
   to be decided based on diff size.
4. `SIGNALS_ENGINE_URL` is unset in this env — feature is inert/disabled by
   default until that's configured, by design (matches the "don't hardcode a
   URL you're not sure is live" instruction).
5. Commit (message ending `Co-Authored-By: Claude <noreply@anthropic.com>`),
   push branch, open PR via `gh pr create` against `main`, being explicit in
   the PR body about what's wired vs. follow-up (per original task
   instructions — do not overstate completeness).

## Constraints (from task, still apply)
- No new dependencies.
- Do not touch auth, Clerk, retention email, or unrelated routes.
- `~/code/signals-app` is read-only reference — do not modify it.
