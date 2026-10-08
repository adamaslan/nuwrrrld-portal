# Watchlist CSV Upload — Implementation Plan (Security-First)

**Status:** proposed · **Written:** 2026-10-07 · **Owner surface:** `/dashboard/portfolio` watchlist panel

Let a signed-in user import many tickers into their watchlist at once by
uploading a CSV, without opening a new path for abuse. The feature is small.
Most of this plan covers what the endpoint must refuse.

---

## 1. What exists today (verified against the code)

| Piece | File | Notes |
|---|---|---|
| List / add one ticker | [app/api/portfolio/watchlist/route.ts](../app/api/portfolio/watchlist/route.ts) | Clerk `auth()`, `normalizeTicker()`, 409 on duplicate, then `enqueueSignalRefresh()` |
| Remove one ticker | [app/api/portfolio/watchlist/[ticker]/route.ts](../app/api/portfolio/watchlist/[ticker]/route.ts) | Uses `toUpperCase()` only, **not** `normalizeTicker()` (see §9) |
| Persistence | [lib/watchlist-store.ts](../lib/watchlist-store.ts) | Neon, parameterized tagged-template SQL |
| Table | `watchlist_items (user_id, ticker, added_at)`, PK `(user_id, ticker)` | [lib/db/schema.sql:104](../lib/db/schema.sql#L104) |
| Ticker validation | `normalizeTicker()` → `/^[A-Z][A-Z.\-]{0,9}$/`; `isCryptoShaped()` | [lib/shared/signal-policy.ts:16](../lib/shared/signal-policy.ts#L16) |
| Known symbols | `ticker_universe (ticker, universe, active)` | [lib/db/schema.sql:353](../lib/db/schema.sql#L353) |
| Signal queue | `enqueueSignalRefresh()` → `pending_signals` (dedupes on `status='pending'`) | [lib/signal-queue.ts:30](../lib/signal-queue.ts#L30) |
| Rate limiter | `rateLimit(key, limit, windowMs)`. **Per instance, in memory.** | [lib/rate-limit.ts](../lib/rate-limit.ts) |
| Edge auth | `proxy.ts` matcher already contains `'/api/portfolio/watchlist(.*)'` | A new `/import` sub-route is covered automatically |
| UI | `PortfolioClient.tsx`; `WATCHLIST_WINDOW = 50` | Seeded watchlists already reach ~1000 rows |

There is **no maximum watchlist size** today. Single adds are limited only by
how fast a person can click. A bulk import removes that natural limit, so it
needs a hard cap (§4.5).

---

## 2. Design decision: parse in the browser, validate on the server

```
[file picker] → browser reads File (size-capped) → extracts candidate strings
      → POST /api/portfolio/watchlist/import  { tickers: string[], dryRun?: bool }
      → server re-validates EVERYTHING → single transactional insert → batched enqueue
```

**Why not upload the file itself (multipart)?**

- The server never sees a file. Nothing is stored, nothing has a filename,
  there is no MIME sniffing, and no CSV parser runs on the server. Formula
  payloads, BOMs, zip bombs and multi-GB uploads have nothing to target.
- The server contract is a plain JSON array of strings, which is the same
  shape `POST /api/portfolio/watchlist` already validates, just more of it.
- The browser-side parse is a **convenience only**. The server treats the
  array as hostile: an attacker can skip the UI and `curl` any JSON they like.
  Every rule in §4 is enforced server-side.

No new dependency. Reading the first column, or the `ticker`/`symbol` column,
from a small CSV is ~30 lines. Do not add `papaparse` unless broker exports
with quoted, multi-line fields turn out to be a real requirement.

---

## 3. Threat model

| # | Threat | Vector | Mitigation (section) |
|---|---|---|---|
| T1 | Unauthenticated write | Call the route with no session | Clerk at the edge (`proxy.ts`) **and** `auth()` in the handler (§4.1) |
| T2 | Writing to another user's list | Supply a `userId` in the body | `userId` comes **only** from `auth()`; the body has no user field (§4.1) |
| T3 | CSRF | A malicious site POSTs with the victim's cookie | Strict `Content-Type: application/json` plus an `Origin` allow-list check (§4.2) |
| T4 | SQL injection | Ticker strings such as `'); DROP …` | Regex allow-list, parameterized `unnest()` insert, no string-built SQL (§4.4, §5) |
| T5 | Resource exhaustion / DoS | Huge body, 100k tickers, many requests | Byte cap read from the stream, item cap, watchlist cap, rate limit (§4.3, §4.5, §4.6) |
| T6 | Queue / pipeline flooding | Import 1000 junk or real tickers to make the backend compute signals | Universe allow-list, so only known symbols are enqueued; one batched enqueue; per-user cap (§4.4, §6) |
| T7 | CSV / formula injection on later export | `=HYPERLINK(...)` stored, then reflected in the privacy export CSV | Regex must start with `[A-Z]` and allows only `A–Z . -`, so `= + - @` cannot lead (§4.4) |
| T8 | Stored XSS | `<script>` as a "ticker" rendered in the UI | Same regex. React escapes as a second layer. Rejected values are never echoed raw (§4.7) |
| T9 | Prototype pollution / type confusion | `{"tickers": {"__proto__": …}}`, nested arrays, numbers | Shape check: `Array.isArray` plus `typeof === "string"` on each item before anything else (§4.3) |
| T10 | Log injection / PII in logs | File content or newlines written to logs | Log only counts and `userId`, never raw input (§4.7) |
| T11 | Enumeration | Use `dryRun` to probe which symbols exist | Harmless, since `ticker_universe` is public market data. `dryRun` still counts against the rate limit |
| T12 | Race between two concurrent imports pushing past the cap | Two tabs import at once | Cap check and insert run in one transaction, with a per-user advisory lock (§5) |

---

## 4. Server rules for `POST /api/portfolio/watchlist/import`

New file: `app/api/portfolio/watchlist/import/route.ts`. Pure validation goes in
a new `lib/watchlist-import.ts` so it can be unit-tested without HTTP.

Read the Next 16 route-handler guide in `node_modules/next/dist/docs/` before
writing it (per `AGENTS.md`).

### 4.1 Authentication and identity
- `const { userId } = await auth(); if (!userId) → 401`. Same as the sibling route.
- The edge matcher in `proxy.ts` already covers `/api/portfolio/watchlist(.*)`.
  Add the route to `docs/API-ROUTE-AUTH.md` as **auth-required**.
- The request body has **no** user field. Any extra key in it is ignored, never used.

### 4.2 CSRF / origin
- Reject with **415** unless `Content-Type` is exactly `application/json`
  (after trimming `; charset=…`). A cross-site HTML form cannot send that
  header, and a cross-site `fetch` with it triggers a CORS preflight that this
  route never answers.
- Reject with **403** when `Origin` is present and is not in the allow-list:
  `NEXT_PUBLIC_APP_URL`, plus `http://localhost:3000` in dev only. Also send
  `Sec-Fetch-Site` and reject `cross-site`.
- No `Access-Control-Allow-*` headers on this route, ever.

### 4.3 Body size and shape (before any parsing work)
- `MAX_IMPORT_BODY_BYTES = 32_768`. Read `req.body` as a stream and abort with
  **413** once 32 KB is exceeded. **Do not trust `Content-Length`**, because it
  can lie or be missing. 500 tickers × ≤ 13 bytes is roughly 7 KB, so 32 KB
  leaves plenty of room.
- `JSON.parse` inside try/catch. Malformed JSON returns **400**.
- Shape: `body` is a plain object, `Array.isArray(body.tickers)`, and every
  element has `typeof === "string"` and `length ≤ 16`. Anything else returns
  **400** with no partial processing.
- `dryRun` must be `true`, `false` or absent. Any other value returns 400.

### 4.4 Per-ticker validation (allow-list, never deny-list)
In this order:
1. `normalizeTicker(raw)`. A `null` result is rejected with reason `invalid`.
2. `isCryptoShaped(t)` true → rejected, reason `crypto_unsupported`. The signal
   pipeline's trading-day math breaks on 24/7 symbols, and they 400 whole
   Alpaca chunks.
3. Dedupe within the upload with a `Set`.
4. **Universe allow-list:** one query,
   `SELECT ticker FROM ticker_universe WHERE active AND ticker = ANY(${arr})`.
   Anything not returned is rejected, reason `unknown_symbol`. This closes T6:
   a user cannot make the backend fetch data for arbitrary strings.
   - Symbology: the universe and `normalizeTicker` already agree on a dot
     (`BRK.B`). If a CSV comes from a Yahoo export (`BRK-B`), map `-` to `.`
     **only** when the dotted form is in the universe. Never guess beyond that.
5. Drop tickers already in the user's watchlist, reason `already_present`.
   This is not an error.

### 4.5 Caps (named constants in `lib/watchlist-import.ts`)
| Constant | Value | Why |
|---|---|---|
| `MAX_IMPORT_BODY_BYTES` | 32 768 | §4.3 |
| `MAX_IMPORT_ROWS` | 500 | More rows than this returns **413** with no partial import, which keeps behavior predictable |
| `MAX_WATCHLIST_SIZE` | 1 500 | Above the ~1000-row seeded lists that already exist. **Owner decision:** consider tying this to `SubscriptionTier` through `hasEntitlement` |
| `IMPORT_RATE_LIMIT` | 5 per hour per user | §4.6 |

If `current + newValid > MAX_WATCHLIST_SIZE`, respond **422** with
`{ error: "watchlist_cap", cap, current, wouldAdd }`. **Do not** silently
truncate. The user decides what to remove.

### 4.6 Rate limiting
- `rateLimit(\`watchlist-import:${userId}\`, 5, 60 * 60_000)` → **429** with a
  `Retry-After` header computed from `resetAt`.
- **Known gap:** `lib/rate-limit.ts` is per serverless instance, so a
  determined user spread across cold starts gets more than 5. That is
  acceptable here because every import is still bounded by the row cap, the
  watchlist cap, and the universe allow-list. The worst case is "up to
  `MAX_WATCHLIST_SIZE` known tickers", which a user can already reach by
  clicking. Upgrade to a shared counter (Upstash, or a Neon
  `watchlist_import_log` row count) only if abuse shows up.

### 4.7 Response and logging
- Success **200** (or 201 when anything was added):
  ```json
  { "added": ["AAPL","MSFT"], "skipped": { "already_present": 3, "unknown_symbol": 2, "invalid": 1, "crypto_unsupported": 0 },
    "rejectedSample": ["XYZQQ","FOO"], "dryRun": false }
  ```
- `rejectedSample` contains at most **20** values, and **only values that
  passed `normalizeTicker`**. Values that failed the regex are counted, never
  echoed, so nothing attacker-shaped is reflected back.
- Log a single line, `watchlist.import userId=… added=N rejected=M dryRun=…`.
  Never log the array or any raw string.
- Errors return generic messages (`"watchlist unavailable"`, 503), matching the
  sibling route. Never return SQL or stack text.

---

## 5. Persistence: one transaction, one statement

Add `addManyToWatchlist(userId, tickers)` to `lib/watchlist-store.ts`. It must
be **parameterized**, never string-concatenated:

```ts
// inside sql.transaction / BEGIN … COMMIT
await sql`SELECT pg_advisory_xact_lock(hashtext(${"watchlist:" + userId}))`;
const [{ n }] = await sql`SELECT count(*)::int AS n FROM watchlist_items WHERE user_id = ${userId}`;
if (n + tickers.length > MAX_WATCHLIST_SIZE) throw new WatchlistCapError(n, tickers.length);
const rows = await sql`
  INSERT INTO watchlist_items (user_id, ticker)
  SELECT ${userId}, t FROM unnest(${tickers}::text[]) AS t
  ON CONFLICT (user_id, ticker) DO NOTHING
  RETURNING ticker, added_at`;
```

- The advisory lock serializes concurrent imports **for the same user only**,
  which closes T12.
- `ON CONFLICT DO NOTHING` makes a retried request idempotent.
- Check which transaction API `lib/db` exposes (Neon `sql.transaction([...])`
  vs. a pooled client) before writing this. If only the non-interactive batch
  form exists, put the cap check into the `INSERT … SELECT … WHERE (SELECT
  count(*) …) + cardinality(...) <= cap` instead.
- No schema migration is needed. The existing PK already enforces uniqueness.

---

## 6. Signal queue: batch it, and only for tickers actually added

Today `enqueueSignalRefresh` is one `INSERT` per ticker. A 500-row import must
**not** make 500 round trips. Add `enqueueSignalRefreshMany(tickers, userId)`
to `lib/signal-queue.ts`:

```ts
INSERT INTO pending_signals (ticker, requested_by)
SELECT t, ${userId} FROM unnest(${tickers}::text[]) AS t
WHERE NOT EXISTS (SELECT 1 FROM pending_signals p WHERE p.ticker = t AND p.status = 'pending')
```

- Enqueue only `rows` returned by the insert (newly added), never the full upload.
- Keep the existing best-effort semantics: a failure here is swallowed, and the
  import still succeeds.
- Skip enqueueing on `dryRun`.

---

## 7. Client (`PortfolioClient.tsx`)

- An `<input type="file" accept=".csv,text/csv">` next to the existing add box.
- Before reading: reject `file.size > 64 * 1024` with an inline error. This is
  UX only, because the server enforces its own cap.
- `await file.text()`, then strip the BOM, split on `\r?\n`, and take the column
  headed `ticker`/`symbol` (case-insensitive) or column 0. Trim, then drop empty
  lines and lines starting with `#`.
- Step 1 is **preview**: POST with `dryRun: true` and show "Will add 42 · 3
  already present · 2 unknown (FOO, BAR…)".
- Step 2 is **confirm**: POST with `dryRun: false` and merge `added` into state.
- Render every value as React text, never `dangerouslySetInnerHTML`.
- Fire an analytics event with counts only (see `lib/analytics.ts` and
  `docs/analytics-event-taxonomy.md`).

---

## 8. Tests (all must pass before the PR)

`lib/watchlist-import.test.ts` (unit, pure):
- Valid list, then normalized and deduped.
- `=CMD|' /C calc'!A0`, `<script>`, `'; DROP TABLE x;--`, `AAPL\nMSFT`, and
  `""` are each rejected as `invalid` and never echoed.
- `BTC-USD` is rejected as `crypto_unsupported`.
- 501 rows → 413. Non-array, nested array, numbers, `__proto__` keys → 400.
- A 17-character string → 400 (shape), before the regex runs.

`app/api/portfolio/watchlist/import/route.test.ts` (mock `auth`, `sql`):
- No session → 401. Wrong content type → 415. Foreign `Origin` → 403.
- A streamed body over 32 KB → 413, even with a lying `Content-Length: 10`.
- The 6th call within an hour → 429 with `Retry-After`.
- Over the cap → 422, with **zero** inserts.
- `dryRun` → no insert, no enqueue.
- The enqueue receives only the newly inserted tickers.

Run:

```bash
cd ~/code/nuwrrrld-portal && npx vitest run lib/watchlist-import.test.ts app/api/portfolio/watchlist/import/route.test.ts
```

Expect: all tests pass, 0 failures.

Confirm the edge matcher covers the route:

```bash
cd ~/code/nuwrrrld-portal && grep -n "'/api/portfolio/watchlist(.\*)'" proxy.ts
```

Expect: one line.

Unauthenticated smoke test against local dev (the server must be running):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/portfolio/watchlist/import \
  -H 'Content-Type: application/json' -d '{"tickers":["AAPL"]}'
```

Expect: `401` or `404` (Clerk `auth.protect()` returns 404 for API routes when
there is no session). Never `200`.

Cross-origin smoke test:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/portfolio/watchlist/import \
  -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' -d 'x'
```

Expect: not `200`.

---

## 9. Adjacent fix found while scoping (separate small PR)

`DELETE /api/portfolio/watchlist/[ticker]` uses `ticker.toUpperCase()` instead
of `normalizeTicker()`. The query is still parameterized, so this is **not**
injectable. It does, however, accept arbitrary-length strings and skip the
shared validator. Route it through `normalizeTicker` and return 400 on `null`,
for consistency.

---

## 10. Rollout checklist

- [ ] `lib/watchlist-import.ts` with pure validation and constants (§4.3–4.5)
- [ ] `addManyToWatchlist` in `lib/watchlist-store.ts` (§5)
- [ ] `enqueueSignalRefreshMany` in `lib/signal-queue.ts` (§6)
- [ ] `app/api/portfolio/watchlist/import/route.ts` (§4)
- [ ] UI preview → confirm flow (§7)
- [ ] Tests (§8), green locally
- [ ] Row added to `docs/API-ROUTE-AUTH.md` (auth-required)
- [ ] 🖱 **Owner decision:** keep `MAX_WATCHLIST_SIZE = 1500` flat, or tier it via `hasEntitlement`
- [ ] Wiki ingest on PR (`docs/wiki-portal/`), plus a parity row in both
      wikis, since mobile has no CSV import (web-only feature)

Find the auth-table row format before adding to it:

```bash
cd ~/code/nuwrrrld-portal && grep -n 'portfolio/watchlist' docs/API-ROUTE-AUTH.md
```

## 11. Explicitly out of scope

- Uploading or storing the CSV file itself (§2).
- Importing positions, quantities or cost basis. This is tickers only; a
  holdings import is a different feature with a different data class.
- A CSV **export** of the watchlist. If added later, prefix any cell starting
  with `= + - @ \t \r` with `'`, even though today's regex already prevents them.
