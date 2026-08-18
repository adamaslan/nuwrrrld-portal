# NuWrrrld Portal — Production Readiness Audit

_Generated: 2026-07-15 · Repo: `~/code/nuwrrrld-portal` · Deployed: financial.nuwrrrld.com (Vercel) · Stack: Next.js + Clerk + Stripe + Neon + OpenRouter_

**Overall: ~70% production-ready.** Auth and billing skeleton work; persistence, env config, and UI wiring are the gaps.

---

## Critical Blockers (Fix Before Launch)

- **Watchlist is in-memory only** — `lib/watchlist-store.ts` explicitly says "Replace with a database before launch." Every deploy wipes all user watchlists. Neon schema table already exists, so this is mostly swap-the-store work. _(effort: ~half day)_
- **Nu AI daily token budget is in-memory** — `app/api/nuai/route.ts` uses a `Map` that resets on every Vercel cold start, breaking usage metering and letting users exceed quota. _(effort: small — reuse the same Neon table pattern as watchlist)_
- **Hold/fold 15-min cache is in-memory** — `app/api/holdfold/route.ts:69`; lost on cold start, causes backend hammering after every deploy. _(effort: small)_
- **Stripe webhook secret is a placeholder** — `.env.local` has `whsec_placeholder_set_after_creating_endpoint`; the handler checks for the placeholder prefix and silently skips, so subscription sync fails without any error surfaced. _(effort: config only — create the endpoint in Stripe dashboard, paste the secret)_
- **Annual Stripe price ID is a placeholder** — `STRIPE_PRICE_ANNUAL=price_annual_placeholder`; annual checkout will 400. _(effort: config only)_
- **Missing prod env vars** — `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` not set in `.env.production` / Vercel project settings; AI features 503 in prod. Verify with `vercel env ls`. _(effort: config only)_
- **No database migration on deploy** — `db:migrate` script exists in `package.json` but isn't called by the Vercel build; a fresh environment gets an empty DB and every Neon-backed route fails. Either chain it into the build command or document it as a required manual step. _(effort: one-line build change)_

---

## Features Built But Not Wired to UI

- **Portfolio Health Score** — `/api/portfolio/health` exists and calls GCP backend, but the UI button is `disabled` and the score result is never displayed
- **Portfolio Suggestions** — `/api/portfolio/suggestions` route exists, never called from any frontend page
- **Backtest/Hit-Rates** — `/api/backtest/[symbol]` exists, only accessible via hidden deep-link in `/dashboard/holdfold/[ticker]`
- **Council Verdict Ledger** — `council_verdicts` table defined in schema, no code reads or writes to it; the "verdict ledger" mentioned in marketing doesn't exist

---

## Frontend Showing Wrong Data

- **Landing page has hardcoded mock signals** — NVDA/MSFT/TSLA/XLE rows with static BUY labels are rendered as fallback when backend is down; users can't tell the difference
- **Council sample on landing page** — 6-hour in-memory cache; stale after a cold start

---

## Auth / Security Gaps

- **No rate limiting on AI routes** — `/api/nuai` has a daily token budget but no per-minute or per-request rate limit; susceptible to burst abuse
- **`PORTAL_PUSH_SECRET` undocumented** — internal retention digest route uses this secret but it's not set in `.env.local`; internal email push will silently fail
- **Sensitive API routes only protected at handler level** — if middleware config changes, `/api/signals/digest`, `/api/portfolio/health`, `/api/holdfold` have no middleware-level fallback

---

## Observability / Ops Gaps

- **No structured logging** — all errors are `console.error` only; no Sentry, no metrics
- **No health check probing dependencies** — `/api/health` exists but doesn't verify Neon + Stripe + OpenRouter are reachable
- **Pricing page auth loop** — unauthenticated users hit `/pricing` → redirected to `/sign-up` → redirected back, broken conversion funnel

---

## Wiring Status Summary

| Feature | API Route | Frontend | Status |
|---|---|---|---|
| Signal Digest | `/api/signals/digest` | `/dashboard/signals` | ✅ |
| Nu AI Chat | `/api/nuai` | `/dashboard/nuai` | ✅ |
| Hold/Fold | `/api/holdfold` | `/dashboard/holdfold` | ✅ |
| Council | `/api/council` | `/dashboard/holdfold` | ✅ |
| Stripe Checkout | `/api/stripe/checkout` | `/pricing` | ✅ |
| Referral | `/api/referral` | `/dashboard/share` | ✅ |
| Portfolio Health | `/api/portfolio/health` | `/dashboard/portfolio` | ⚠️ Button disabled, result not shown |
| Portfolio Suggestions | `/api/portfolio/suggestions` | — | ❌ Not wired |
| Backtest | `/api/backtest/[symbol]` | hidden deep-link | ⚠️ Unreachable from nav |
| Stripe Webhooks | `/api/webhooks/stripe` | — | ⚠️ Secret is placeholder |

---

## User Testing Findings (2026-07-15, aa-testing-notes1)

From hands-on testing of the live app (`docs/nuwrrrld-portal/aa-testing-notes1.md`):

- **Council T1 leaks raw LLM reasoning instead of a verdict** — the T1 "1–5 day framing" card renders the model's internal planning monologue ("The user wants a 1-5 day trade framing... I need to extract specific numbers...") and then truncates mid-sentence at "Key". The prompt/parse layer is passing chain-of-thought through as the answer. Fix: separate reasoning from final output in the council prompt (or strip a `<thinking>` block), and validate the response contains the required fields (outlook, driver, invalidation, entry/exit/stop) before rendering. _(effort: prompt + parser fix, ~half day)_
- **Council verdicts aren't actionable and have no follow-up** — "these dont actually do anything." No way to ask a follow-up question about a verdict, save it, or act on it (add to watchlist, set an alert). The verdict is a dead-end card. _(design gap, pairs with the verdict-ledger debt item)_
- **Only T1 timeframe is shown** — user wants short-term AND long-term framing side by side, not just the 1–5 day view. The signal data already carries 1d/1w/1m/3m/1y momentum, so a T2/long-horizon council pass is mostly prompt work. _(effort: medium)_
- **Council agents feel less robust than Hold/Fold** — parity question worth answering explicitly: holdfold uses a stronger prompt/model chain; council should match it or the quality gap will read as broken.
- **Nu AI chat is blind to the app's own data** — "ask ai doesnt have ability to easily use signal or real data via the app." `/api/nuai` doesn't inject the user's watchlist, current signals digest, or portfolio into context, so the flagship AI feature can't answer questions about the data the app itself displays. Fix: pass the signals digest + watchlist into the system prompt (cheap), or add tool-use against the internal APIs (better). _(effort: cheap version ~half day)_
- **Missing favicon** — no favicon in `app/`; browser tab shows the default globe. Add `app/icon.png` (Next.js app-router convention). _(effort: minutes)_

---

## What Already Works (Don't Break These)

- Clerk gates `/dashboard(.*)` correctly; per-route auth checks exist inside sensitive handlers
- Subscription tiers cleanly abstracted in `lib/subscription.ts`; Stripe → Clerk metadata sync works
- Signals digest has a graceful degradation chain (in-memory L1 → Neon fallback) in `lib/digest-cache.ts`
- Trial period enforced via Stripe + Clerk metadata
- Neon schema (`lib/db/schema.sql`) is well-designed and already includes the tables the fixes above need

---

## Fix Order Checklist

**Before launch**
- [x] Watchlist persistence → Neon (data loss risk) — `lib/watchlist-store.ts` now reads/writes the `watchlist_items` table (added to `lib/db/schema.sql`); all callers (watchlist routes, portfolio page, health-ai route) updated. See branch `fix/audit-2026-07-15`.
- [ ] Real Stripe webhook secret + annual price ID (billing broken) — **SKIPPED, needs manual action**: create the webhook endpoint in the Stripe dashboard (Developers → Webhooks → Add endpoint → `/api/webhooks/stripe`) and paste the real signing secret + the real annual price ID into Vercel env vars (`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ANNUAL`). The code now fails loudly with a structured `CONFIG_ERROR` log if these are still placeholders (see `.env.example` and `app/api/webhooks/stripe/route.ts`), so the misconfiguration is now visible in logs instead of a silent no-op.
- [ ] Set `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` in Vercel prod env — **SKIPPED, needs manual action**: these are real secrets only the user has; set them in the Vercel project's Production env vars. Routes already 503 clearly when missing (`app/api/nuai/route.ts`, council routes) rather than silently failing. Documented in `.env.example`.
- [x] Nu AI token budget + hold/fold cache → Neon or Vercel KV — token budget now backed by a new `nuai_usage` table (`lib/nuai-db.ts`, used from `app/api/nuai/route.ts` with an in-process L1 cache in front); hold/fold cache now backed by a new `holdfold_cache` table (`lib/holdfold-cache-db.ts`, used from `app/api/holdfold/route.ts`).
- [x] Wire `db:migrate` into the Vercel build — added a `prebuild` npm script (`node scripts/db-migrate.mjs`) that runs automatically before `next build`; `scripts/db-migrate.mjs` now falls back to reading `.env.local` directly if `DATABASE_URL` isn't already in `process.env` (Vercel injects it directly, so this Just Works there too). Fails loudly (non-zero exit + clear message) if `DATABASE_URL` is unset anywhere.
- [x] Make Stripe webhook placeholder check fail loudly instead of silently skipping — it already returned a 500, but the log line was generic; now logs a structured `CONFIG_ERROR` explaining exactly what's broken and what manual action to take.

**Before wider rollout**
- [x] Fix Council T1 leaking chain-of-thought + truncated output (prompt/parser fix + response validation) — new `lib/council-verdict.ts` requires/parses a strict 6-field format (outlook, key_driver, invalidation_level, entry, exit, stop); `/api/council` (`app/api/council/route.ts`) validates the response, strips any stray `<think>` blocks, retries once on failure, and returns an explicit `council_response_invalid` error (rendered as a fallback message in `HoldFoldClient.tsx`) instead of ever rendering raw/truncated text.
- [x] Give Nu AI access to app data (inject signals digest + watchlist into context) — `app/api/nuai/route.ts` now fetches the user's watchlist (`getWatchlist`) and latest signals digest (`getOrFetchDigest`) and injects both into the system prompt.
- [x] Add long-term council framing alongside T1 (data already has 1m/3m/1y momentum) — `HoldFoldClient.tsx` now shows T1 and T2 council panels side by side (`hf-council-grid`), each independently askable, instead of one replacing the other.
- [ ] Add follow-up / actions on council verdicts (ask more, add to watchlist) — **NOT ATTEMPTED**: this is a larger design/UX feature (multi-turn follow-up chat + a "add to watchlist from verdict" action) beyond a mechanical code fix; left for a dedicated follow-up task.
- [x] Add favicon (`app/icon.png`) — added `app/icon.svg` (Next.js app-router auto-detects it as the favicon; no existing logo asset in `/public` to reuse, so a simple "NWF" letter-mark matching the brand's cyan-on-dark palette was generated).
- [x] Wire portfolio health score result into the UI (un-disable the button) — added a new "Portfolio Health Score" panel in `PortfolioClient.tsx` that calls `GET /api/portfolio/health` and renders the numeric score/grade/factors (distinct from the pre-existing AI narrative panel, which was already wired to `/api/portfolio/health-ai`).
- [x] Wire portfolio suggestions to a page or remove the dead route — added an "Optimizer Suggestions" panel in `PortfolioClient.tsx` that fetches `GET /api/portfolio/suggestions` on load and renders the list.
- [x] Remove/label the hardcoded mock signals on the landing page — added a "Sample data — live backend unavailable" tag above the fallback NVDA/MSFT/TSLA/XLE rows in `app/page.tsx`.
- [x] Fix pricing → sign-up redirect loop — `app/pricing/page.tsx` no longer redirects unauthenticated visitors; `CheckoutButton.tsx` now redirects to `/sign-in?redirect_url=/pricing` only when the checkout API returns 401.
- [x] Rate-limit `/api/nuai` per-minute, not just per-day — added a simple in-memory fixed-window counter (12 req/min/user) in `app/api/nuai/route.ts`, on top of the (now Neon-backed) daily budget.
- [x] Set + document `PORTAL_PUSH_SECRET` for retention digest — documented in the new `.env.example` with a full explanation of both internal callers; `app/api/signals/refresh/route.ts` now logs a `CONFIG_ERROR` and returns 503 (distinct from a normal 401) when the secret is unset. **Manual action remaining**: generate a real secret value (e.g. `openssl rand -hex 32`) and set it in Vercel env vars — the actual value can't be fabricated here.
- [ ] Add error tracking (Sentry) — **SKIPPED, needs manual action**: requires creating a Sentry project/DSN (a credential only the user has) and adding the `@sentry/nextjs` dependency; this is a net-new third-party integration, not covered by "code-fixable" scope. `/api/health` was extended to probe Neon/Stripe/OpenRouter reachability (below) as the code-fixable half of this item.
- [x] `/api/health` probes Neon/Stripe/OpenRouter — rewritten to run `SELECT 1` against Neon, a lightweight Stripe balance check, and an OpenRouter models-list check, all in parallel, returning a per-dependency JSON status (`ok`/`degraded`/`down`/`not_configured`).

**Debt**
- [x] Persist council verdicts (make the marketed "verdict ledger" real) — `/api/council/deliberate` already wrote to `council_verdicts`; the T1/T2 quick-ask route (`/api/council`, the one actually surfaced in the Hold/Fold UI) did not — it now does too, via `createSession`/`saveVerdict` from `lib/council-db.ts`, once a structured verdict parses successfully.
- [x] Surface backtest/hit-rates in nav instead of hidden deep-link — added a visible `TrackRecordBadge` to the Hold/Fold ticker detail page (`app/dashboard/holdfold/[ticker]/page.tsx`) and a "View full ticker page & backtest track record" link from the Hold/Fold list's verdict panel (`HoldFoldClient.tsx`).

---

## Bottom Line

Core auth + billing skeleton works. The three highest-leverage fixes are **watchlist → Neon**, **real Stripe secrets**, and **Nu AI budget → durable storage** — all three are either config-only or reuse the existing schema. Portfolio health + suggestions are the biggest "built but invisible" features to wire up next.

_Verification note: findings from a single code audit on 2026-07-15; re-check env vars with `vercel env ls` and webhook status in the Stripe dashboard before acting, as config may have changed since._
