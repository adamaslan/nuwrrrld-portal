# NuWrrrld Portal — Launch Todo (Subscriptions Live + Core Features Tested)

**Created:** 2026-07-13
**Goal:** Get `financial.nuwrrrld.com` launched and accepting paid subscriptions, with every
core feature working, tested for bugs, and hardened for security.
**Surface:** `nuwrrrld-portal` (Next.js 16 / Vercel), backend `gcp3` (Cloud Run MCP), Neon Postgres, Clerk, Stripe, OpenRouter.

> Grounded against the codebase on 2026-07-13. Many June-roadmap items already shipped
> (backtest PR #22, AI fallback chain #19, data-quality-score #23, legal pages #17,
> ask-anything chat on `feat/signal-ask-anything`). This todo lists **only what's still open**
> to be launch-ready. Excludes `docs/portal-10x-council-db-local.md` per instruction.

---

## 🔴 P0 — LAUNCH BLOCKERS (nothing launches until these are green)

### P0-1. Watchlist persistence (SILENT DATA LOSS — highest priority)
`lib/watchlist-store.ts` is still `export const store = new Map()` with a
`// Replace with a database before launch` comment. Every Vercel cold start wipes
every user's watchlist. This is the single most important open item.

- [ ] Create `watchlist` table in Neon:
      `user_id text, ticker text, added_at timestamptz default now(), primary key (user_id, ticker)`.
- [ ] Add a migration script in `db/migrations/` (archive old approach, never delete — global rule).
- [ ] Rewrite `lib/watchlist-store.ts` to back onto `lib/db.ts` (the `sql` client already used by
      `digest-cache-db.ts`). Keep an async `store`-shaped interface OR update the two routes:
      - `app/api/portfolio/watchlist/route.ts` (GET list, POST add)
      - `app/api/portfolio/watchlist/[ticker]/route.ts` (DELETE)
- [ ] Both routes must `await` the DB and stay scoped to the authed `userId` (never trust client-supplied user id).
- [ ] **Verify:** add ticker → wait for idle/redeploy → reload → still there. (`/verify` skill.)

### P0-2. Confirm Clerk PRODUCTION instance is live in Vercel prod
`.env.production` has `pk_live_`/`sk_live_`; `.env.local` is `pk_test_`. Need to confirm the
Vercel **Production** environment (not Preview) actually serves the live instance.

- [ ] Confirm Vercel prod env vars use `pk_live_`/`sk_live_` (dashboard → Settings → Environment Variables → Production).
- [ ] Confirm production allowed origins on the Clerk live instance include `financial.nuwrrrld.com`.
- [ ] Google OAuth: memory says prod Google client is configured; verify sign-in with Google works on live domain.
- [ ] Confirm the `dev-browser-missing` / 404-on-`/dashboard` behavior is gone under the live instance.
- [ ] Confirm `subscription_status` Pro metadata gates correctly on the **live** instance (not just dev).

### P0-3. End-to-end Stripe checkout on LIVE keys → Pro unlocks
Webhook coverage is good (`checkout.session.completed`, `subscription.{created,updated,deleted}`,
`invoice.payment_failed`). Must prove the full loop on live keys.

- [ ] Verify `.env.production` / Vercel prod has **live** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
      publishable key, and the two price IDs (`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`).
- [ ] Register the **production** webhook endpoint in the Stripe dashboard pointing at
      `https://financial.nuwrrrld.com/api/webhooks/stripe`; confirm its signing secret matches env.
- [ ] Full live test (real card or Stripe test-mode dry run first): checkout → webhook fires →
      Clerk `subscription_status` flips to Pro → gated surfaces (Nu AI, digest, health, council) unlock.
- [ ] Test cancellation: `subscription.deleted` → status flips back → Pro surfaces re-gate.
- [ ] Test `invoice.payment_failed` path → user sees a clear "payment failed" state, not a crash.
- [ ] Verify `hasEntitlement` / `tierFromStatus` / `isTrialExpired` (`lib/subscription.ts`) are actually
      called on **every** gated route + page, not just some.

### P0-4. Backtest feature: decide inert-vs-live before launch
`lib/backtest.ts` + `app/api/backtest/[symbol]/route.ts` are merged but `SIGNALS_ENGINE_URL` is
unset, so `TrackRecordBadge` renders nothing.

- [ ] Decide: (a) set `SIGNALS_ENGINE_URL` to a deployed `signals-app` and ship the badge, or
      (b) leave it inert and hide the badge entirely so users don't see a dead/empty element.
- [ ] Whichever path: no broken/empty UI ships. Verify the chosen state in the live build.

---

## 🟠 P1 — CORE FEATURES: verify each works end-to-end (bug pass)

No automated tests exist yet, so each core surface needs a manual end-to-end pass under the
**live** instance + persistence. Log the result of each.

- [ ] **Signals digest** — `/dashboard/signals`: loads real gcp3 data, staleness + provenance +
      `data_quality_score` render, degrades gracefully when backend is down (PR #21 path). No hallucinated numbers.
- [ ] **Ask-anything chat** — finish/merge `feat/signal-ask-anything` (open PR, run `/wait1`), then verify
      the per-signal chat streams, stays grounded in `=== REAL DATA ===`, and respects the token budget.
- [ ] **Nu AI** (`/dashboard/nuai`) — SSE streams; free→Pro gate enforced; model fallback chain
      (Qwen → Cohere → Mistral) actually fails over on a 429; per-user daily token budget enforced.
- [ ] **Hold/Fold** (`/dashboard/holdfold` + `[ticker]`) — verdict renders on real data, gating correct.
- [ ] **Portfolio** (`/dashboard/portfolio`) — watchlist (now persistent), health, health-ai, suggestions all work.
- [ ] **Council** (`/dashboard/council` via API) — multi-model answer streams and stays grounded.
- [ ] **Brief / Health** SSE routes — stream shape correct, empty/error states handled.
- [ ] **Retention** — streak, trial-nudge, digest-email routes fire correctly under persistence + live Clerk.
- [ ] **Referral** (`api/referral`) — code generation + redemption survive cold start (needs DB-backed, not in-memory).

---

## 🟡 P2 — SECURITY HARDENING (before real users / real cards)

- [ ] **Auth on every route:** audit all `app/api/**/route.ts` — each non-public route must
      `auth()`-guard and derive `userId` server-side. No route trusts a client-supplied user id.
- [ ] **Entitlement on every gated route:** confirm Pro-only endpoints re-check `hasEntitlement`
      server-side (never rely on the client hiding a button).
- [ ] **Stripe webhook signature** verified on every event (confirm `STRIPE_WEBHOOK_SECRET` check
      can't be bypassed); **Clerk webhook** (`api/webhooks/clerk`) signature verified too.
- [ ] **Input validation** on all POST bodies (ticker format, chat length, symbol allowlist) — reject
      oversized/malformed input to protect the AI token budget and DB.
- [ ] **Rate limiting** on AI + chat routes per user (protect OpenRouter quota + cost).
- [ ] **Secrets audit:** no secret keys committed; `.env*` gitignored; confirm no `pk_live`/`sk_live`
      or DB URL leaked into client bundle (only `NEXT_PUBLIC_*` reaches the browser).
- [ ] **SQL safety:** all Neon queries use the tagged-template `sql` client (parameterized) — no string interpolation.
- [ ] Run `/security-review` on the branch before the launch merge.

---

## 🟢 P3 — TEST COVERAGE + CI (make "tested thoroughly" real)

- [ ] Add a test runner (vitest) — none exists today.
- [ ] **Persistence tests:** watchlist CRUD against Neon (add/list/delete, user isolation).
- [ ] **Subscription gating tests:** `hasEntitlement` / `tierFromStatus` / `isTrialExpired` truth table.
- [ ] **AI route smoke tests** (the 5 streaming routes): auth gate, free→Pro gate, SSE shape,
      empty-data handling, fallback-chain trigger.
- [ ] **Stripe webhook tests:** each event type mutates status correctly; bad signature rejected.
- [ ] **GitHub Actions:** replace the free-models-only workflow context with a PR gate =
      `typecheck + build + lint + test`. (Vercel preview covers deploy; CI covers correctness.)

---

## 🔵 P4 — LAUNCH POLISH (last mile)

- [ ] **Onboarding:** first-run flow — explain signals → add first watchlist ticker → run first AI brief.
- [ ] **Empty states** everywhere (no watchlist, no signals matching filter, AI not yet run, backtest inert).
- [ ] **Paywall copy:** clear Pro value props on each gated surface.
- [ ] **Legal:** ToS + Privacy already live (#17) — final read-through; link them from footer + sign-up consent.
- [ ] **Meta/OG tags + pricing copy** final pass on landing + `/pricing`.
- [ ] **Observability:** add Sentry (or equivalent) to capture route errors + AI failures on Vercel.
- [ ] **Structured logging** on API routes (status, model, user tier, latency) so quality is measurable.

---

## Launch checklist (all must be ✓ to go live)
- [ ] P0-1 Watchlist persists across cold starts
- [ ] P0-2 Live Clerk instance serving prod
- [ ] P0-3 Live Stripe checkout → Pro unlock proven end-to-end
- [ ] P0-4 Backtest feature is either live or cleanly hidden
- [ ] P1 Every core feature passed a manual e2e bug pass
- [ ] P2 `/security-review` clean; auth + entitlement on every route
- [ ] P3 CI green (typecheck + build + lint + core tests) on PRs
- [ ] P4 Onboarding, empty states, legal, observability in place

## Guardrails (apply throughout)
- **Fullstack parity:** canonical core in `gcp3-mobile/lib`, mirror to `portal/lib/shared`. Never fork logic. (See `nuwrrrld-fullstack` skill.)
- **No destructive ops without warning** (DB drops, MX/DNS, killing processes holding creds).
- **No secrets in chat/commits** — source from env files.
- **Every AI feature stays grounded** in fetched real data (`=== REAL DATA ===`); never invent numbers.
- **Free vs. Pro gating** preserved server-side on every surface.
