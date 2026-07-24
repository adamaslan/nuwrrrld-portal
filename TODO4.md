# TODO4 — ship the three deferred items

From TODO3's "Still deferred". Two live in `homebase/` (separate repo, but a
working dir), one is in-repo CI.

## Phase 1 — Modal/Zo cron that calls POST /api/signals/drain
- [x] `homebase/modal_drain.py` — a lightweight Modal scheduled function
      (httpx only, no yfinance) that POSTs to `{PORTAL_URL}/api/signals/drain`
      with `Authorization: Bearer {PORTAL_PUSH_SECRET}`, every 5 min during
      market hours. Re-uses the existing `nuwrrrld-secrets` Modal secret.
- [x] Loops the drain until the queue is empty or a call budget is hit, since
      one drain processes at most BATCH_SIZE (8) tickers.

## Phase 2 — Finnhub WebSocket live-price tier
Portal side (this repo, validated by tsc + vitest):
- [x] `live_prices` table in `lib/db/schema.sql`.
- [x] `lib/shared/live-price.ts` — pure `parseLivePriceBatch` (validation,
      dedup-latest-per-ticker), unit-tested.
- [x] `lib/live-price-db.ts` — guarded `upsertLivePrices` / `getLivePrice`.
- [x] `POST /api/signals/live` (Bearer PORTAL_PUSH_SECRET) upsert +
      `GET ?ticker=` read.
- [x] `__tests__/live-price.test.ts`.

Homebase side:
- [x] `homebase/modal_finnhub_ws.py` — persistent Modal container holding a
      Finnhub trades WS subscription (via existing `FinnhubWsClient`),
      debounces ticks, POSTs batches to `/api/signals/live`.

## Phase 3 — wire the integration test to a CI Neon branch
- [x] `.github/workflows/integration-tests.yml` — create an ephemeral Neon
      branch, migrate, run the guarded integration test, delete the branch.
- [x] `test:integration` script in `package.json`.
- [x] Document the required repo secrets (`NEON_API_KEY`, `NEON_PROJECT_ID`).

## Verify
- [x] `tsc --noEmit` + `vitest run` green (portal).
- [x] `python -m py_compile` the two new homebase modules.
