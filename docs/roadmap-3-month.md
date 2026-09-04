# 3-Month Roadmap — nuwrrrld-portal

**Written:** 2026-08-28 · **Baseline:** `main` @ `2273506` (PR #75 merged),
branch `docs/uni1-refresh`
**Horizon:** Sep–Nov 2026 (Month 1 = Sep, Month 2 = Oct, Month 3 = Nov)

Grounded in the repo's own state docs, not a generic plan:
`docs/pipeline-todo-blockers.md`, `docs/known-bugs.md`, `docs/uni1.html`,
`docs/session-handoff.md`, `docs/wiki-portal/concept-mobile-web-parity.md`,
`docs/stripe-todo.md`.

---

## The one-sentence read

**The pipeline is built and the product is not yet sellable.** 932/933 tickers
are hydrated and 918 t1 cards are rankable, but **0** of them have AI narrative
(quota), **0** grounding chunks exist (corpus not migrated), the `e2e` CI tier
has never run once (no WIF), and Stripe annual checkout is a placeholder. The
next 90 days should be spent converting *built* into *live*, then *live* into
*paid* — not building new subsystems.

### What the numbers say today

| Metric | Value | Meaning |
|---|---|---|
| Universe coverage | 932 / 933 | Hydration works |
| Rankable t1 cards | 918 | Ranking works (was 0 pre-#70) |
| Precomputed AI narratives | **0** | Blocked on OpenRouter quota |
| Grounding pack chunks | **0** | Tier 0 does not exist |
| Mobile⇄web parity | ~66% | 13 shared modules portal / 5 mobile |
| Red CI checks on `main` | 6 | `e2e` ×4, `shared-drift`, Cloudflare Pages |
| Open items in `known-bugs.md` | 7 | 2, 3, 12, 13, 14, 15, 16 |

---

## Month 1 (September) — Turn on what's already built

**Theme: no new subsystems.** Every item here is a credential, a decision, or a
one-command run. The pipeline was built assuming these would land; until they do,
the product renders empty cards.

### M1.1 — Light the hydration lane (week 1, ~1 day)

The `hydrate-universe.yml` cron is registered and firing, and failing fast every
weekday at 22:30 UTC because `ALPACA_API_KEY`/`ALPACA_API_SECRET` aren't in repo
secrets.

- [ ] Create/confirm the Alpaca account (free tier covers the bars endpoint used)
- [ ] `bash scripts/sync-hydration-secrets.sh --dry-run` then without the flag
- [ ] Confirm one clean scheduled run end-to-end, not just a manual dispatch

> ⚠️ Secret values must never pass through an agent session — the script pipes
> them from `.env.local` into `gh secret set` directly. Run it yourself.

**Done when:** two consecutive scheduled runs green and `coverageForDate` is
current for the prior trading day.

### M1.2 — Kill the double-spend, then buy quota (week 1–2)

Two schedulers still fire `10 0 * * *` at `/api/pipeline/precompute-ai`
(`.github/workflows/precompute-ai.yml` and `deploy/precompute-ai/modal_app.py`).
The Modal lane has never been deployed, so this is currently latent — but any
Modal deploy makes it a real double-spend of a quota that is already exhausted.

- [ ] Delete the Modal schedule; GHA is the survivor (its own comment argues this)
- [ ] **Decide the LLM budget.** This is the single highest-leverage decision in
      the quarter. 918 rankable cards × 1 narrative each cannot run on a free
      tier at any batching factor. `batchThesisSubjects()` already packs 10
      tickers/prompt (PR #72), so a 100-ticker sweep is 10 requests — the
      batching work is done; the credits are not.
- [ ] Fix `FREE_MODEL_CHAIN`'s nominal-depth-4/real-depth-1 problem: all four
      entries are `nvidia/*`, so the chain absorbs nothing at an account-tier
      failure — which is the failure that actually happens
      ([[entity-openrouter-client]]).

**Done when:** the daily precompute writes non-zero narratives and one scheduler
exists.

### M1.3 — Decide the corpus, or formally park Tier 0 (week 2)

`corpus/` holds two files its own README marks as samples. The real trader Q&A
set lives in a sibling repo's `DOCS_ROOT` that isn't checked out. Compiling from
what's present would fill Tier 0 with **confident, verbatim-cited, irrelevant
rules — worse than empty, because it looks grounded.**

Three honest options; pick one and write it down:

| Option | Cost | Consequence |
|---|---|---|
| Migrate the real corpus | Human review + extraction credits | Tier 0 works; council answers get grounded |
| Park Tier 0 explicitly | Free | Ladder degrades to Tier 1+ permanently; document it as intended |
| Compile from what's here | Cheap | **Do not.** Plausible-sounding wrong grounding |

Extraction is one model call per chunk. A few-hundred-chunk corpus needs credits,
batching, or a multi-day incremental run — **plan this before the migration, not
after.**

**Done when:** a `decision-*.md` page in `docs/wiki-portal/` records the choice.

### M1.4 — Get `e2e` running for the first time (week 2–3)

All four `e2e` shards fail at "Authenticate to GCP (keyless)" because
`GCP_WIF_PROVIDER` doesn't exist. This predates every PR in the last two sessions
and fails identically on `main`. The suite has **never run**, so its 34 tests are
currently worth zero.

- [ ] `bash scripts/sync-e2e-secrets.sh --provision-wif`, grant the printed SA
      only `roles/run.invoker` on `gcp3-backend`
- [ ] Re-run the `frontend` tier — item 1 (Pro entitlement) is fixed, so the
      6+ redirect-to-`/pricing` failures should clear; item 3's root cause
      confirms or falsifies itself here
- [ ] Disable the broken Cloudflare Pages integration via the Cloudflare API
      (`docs/cloudflare-pages-assessment.md`) — known-broken since PR #37, it's
      pure noise in every PR's check list

**Done when:** CI on `main` is green except for deliberate, named exceptions.

### M1.5 — Finish Stripe (week 3)

`STRIPE_PRICE_ANNUAL` is a placeholder, `STRIPE_WEBHOOK_SECRET` unset. This gates
`preflight-billing` entirely and makes `/api/health` report Stripe
`not_configured` — but more importantly, **annual checkout does not work**, and
annual is the plan the pricing page markets as "save 34%".

- [ ] Create the annual price in Stripe, set the webhook endpoint, fill both
      (`docs/stripe-todo.md` has exact retrieval steps)
- [ ] Rotate `STRIPE_SECRET_KEY` — already exposed, tracked in `docs/env-rotation.md`
- [ ] Run one real end-to-end trial → active → cancel cycle against the test mode
      and verify Clerk `publicMetadata` reflects each transition

**Done when:** `preflight-billing` passes and a human has completed a real
checkout.

**Month 1 exit criteria:** hydration cron green · non-zero AI narratives daily ·
corpus decision recorded · `e2e` running · annual checkout live.

---

## Month 2 (October) — Make the data trustworthy and the product legible

With the lanes live, the failure modes shift from "nothing runs" to "things run
and are quietly wrong." This month is about closing the correctness gaps the
pipeline docs already name.

### M2.1 — `signal-lookup.ts`'s 200-with-error blindness (Blocker 8)

`fetchTickerEntryLive()` collapses "gcp3 down", "timed out", and "ticker out of
scope (`200` + `{"error":"not found"}`)" into the same `null`. Named in
`pipeline-todo-blockers.md` as **"the single highest-clarity-per-effort item
outstanding."**

- [ ] Ship the `LiveFetchResult` discriminated union
      (`docs/modal-vs-gcp-signal-coverage.md` Part 5 Lane A)
- [ ] Propagate the distinction into `/api/health` and into UI messaging —
      "we can't reach the backend" and "we don't cover this ticker" are
      different sentences to a user
- [ ] Extend `HealthBanner.tsx` to reflect the new states

### M2.2 — Resolve the ETF explain-quality gap (Blocker 1)

Alpaca-hydrated ETF cards now reach `dataQuality: 1.0`, so this has narrowed to
the gcp3-sourced path only — but the design question is still open. gcp3's ETF
payload fills 1 of 5 taxonomy inputs (`confluenceScore`); `rsi`, `macdCross`,
`adx`, `volatilityPercentile` are out of scope for its ETF model entirely.

- [ ] Decide: extend gcp3's ETF path to compute the four missing indicators
      (it already has `features_rsi.py`, just unwired), **or** retire the
      gcp3 ETF lane now that Alpaca covers it and remove the dead path
- [ ] Whichever wins, delete the loser — two lanes producing differently-shaped
      cards for the same asset class is a bug factory

### M2.3 — De-duplicate the indicator math

There are now **two** implementations of RSI/MACD/ADX/volatility:
`deploy/universe-hydration/modal_app.py` (Python) and `scripts/hydrate-local.mjs`
(JS). PR #67's review found the first JS cut shipped placeholder indicators that
looked plausible — `macdCross` returned a five-bar price direction, `confluence`
mixed in `Math.random()`. It's now a faithful port pinned by
`__tests__/hydrate-indicators.test.ts`, but this is exactly the duplication cost
`incident-2026-08-18-modal-under-recommended.md` warned about.

- [ ] Since the Modal lane is now redundant (GHA is the surviving scheduler),
      **delete `deploy/universe-hydration/modal_app.py`** and make the JS the
      single implementation — or formally designate Python as canonical and
      generate/verify the JS from it. Do not leave two hand-maintained copies.

### M2.4 — Close the parity gap deliberately, not incidentally

Parity has sat at **~66%** across eleven consecutive PRs (#48 → #75), every one
assessed "headline unchanged." That's not stability, it's *all recent work
landing portal-only*. The single-source denominator drifted further at PR #71
(portal added `lib/shared/universe-policy.ts`; portal 13 shared modules, mobile 5).

Pick **two** genuine parity items and ship them cross-repo:

- [ ] Port `lib/shared/analyze-policy.ts` to mobile (PR #56 flagged it as the
      exact starting state `signal-policy.ts` was in before mobile adopted it)
- [ ] Expose `/api/signals/top` on mobile — the ranking now exists and mobile
      can't see it
- [ ] Recompute the headline honestly in **both** wikis per
      `~/.claude/rules/mobile-web-wiki-sync.md`

> If parity isn't actually a goal this quarter, say so in
> `concept-sync-requirements.md` and stop paying the drift-gate tax. The worst
> outcome is maintaining the ceremony without the benefit.

### M2.5 — Retire the doc sprawl

`docs/` holds 60+ files, several untracked, plus `TODO.md`–`TODO4.md`,
`nextphase.md`, `nu1.md`, and 13 pre-existing untracked files classified in
`docs/docs-inventory.md` but never resolved (handoff item 5, open since 2026-08-18).

- [ ] Archive superseded docs to `docs/archive/` with the timestamped header
      (per the global archive-never-delete rule)
- [ ] Collapse `TODO*.md` into one live list; the rest go to archive
- [ ] Resolve the untracked 13 — commit, archive, or gitignore; three are
      personal notes unrelated to this repo

**Month 2 exit criteria:** failure modes distinguishable in the UI · one ETF lane ·
one indicator implementation · a parity number that moved (or an explicit decision
that it won't) · `docs/` navigable.

---

## Month 3 (November) — Convert to a product people pay for

Months 1–2 make the machine correct. Month 3 is the first month where new
user-facing work is the right call.

### M3.1 — Make the ranking visible

`GET /api/signals/top` exists (PR #71) and, until that PR, *nothing in the
product read the ranking at all*. There is still no primary UI surface for
"here are today's best 20 tickers, ranked, with a reason" — which is arguably the
product.

- [ ] A ranked-universe page: 918 cards → top-N with score, action, horizon,
      and (post-M1.2) the precomputed narrative
- [ ] Wire it into `/dashboard` as the default landing view for paid users
- [ ] Filters that match `universe-policy.ts`'s real decisions (scope, horizon,
      strong-card threshold) rather than inventing new ones

### M3.2 — Close the retention loop

`/api/retention/digest-email`, `/streak`, `/trial-nudge` and `/api/push/register`
all exist as routes. Verify each is actually *called* by something on a schedule —
the pipeline docs show a repeated pattern in this repo of built-and-never-invoked
endpoints (`/api/pipeline/*` was untracked in git for weeks; `topCards()` had no
reader for months).

- [ ] Audit every route under `app/api/` for "has a caller in production"
- [ ] Delete or schedule the orphans — an endpoint with no caller is a liability
- [ ] Ship the daily digest email against the ranked universe

### M3.3 — Entitlement design cleanup (known-bugs #15)

`app/dashboard/portfolio/page.tsx:63` gates the whole page on `hasEntitlement("nu_ai")`
even though `FEATURE_TIER_MAP` defines `portfolio_score: 'free'` separately. Either
intentional (the page bundles AI) or accidental — it has never been decided.

- [ ] Decide, and make the code say what's meant. If portfolio scoring is a free
      hook into paid AI, gate at the component, not the route.

### M3.4 — Remove the fragile auth workaround (known-bugs #16)

`e2e/auth.setup.ts` depends on `E2E_CLERK_TEST_EMAIL` being a `+clerk_test`
address exempt from real verification. Functional but the most fragile step in
the whole setup — disabling new-device verification on the dev Clerk instance
removes it entirely.

### M3.5 — Optional, only if staleness becomes a real complaint

Step 6 of `universe-scale-hydration.md` (hot-set intraday lane) was written as
optional and gated on staleness being an *actual* complaint rather than an
anticipated one. It isn't one. **Keep it parked** unless M3.1 surfaces users
asking for it.

**Month 3 exit criteria:** the ranking has a UI · every API route has a caller ·
entitlements say what they mean · a paying user can complete the full loop.

---

## Explicitly NOT in this roadmap

Naming these prevents them from creeping in:

- **Modal deployment.** GHA is the surviving scheduler. Modal is a redundancy
  gap, not an outage.
- **The hot-set intraday lane.** Parked by design (see M3.5).
- **New AI features.** The council, Nu AI, and portfolio intelligence all exist
  and mostly work; none of them are the bottleneck.
- **A second data backend.** There are already two (`gcp3-backend` and
  `holdemfoldem-api` via `MCP_ANALYZE_URL`). M2.2 should reduce that count, not
  grow it.

---

## The dependency spine

Order matters more than dates. Each of these gates the next:

```
Alpaca creds ──► hydration cron live ──► fresh cards daily
                                            │
LLM budget ─────► precompute runs ──────────┴──► narratives exist
                                                     │
corpus decision ─► Tier 0 exists (or is parked) ─────┤
                                                     ▼
WIF ──► e2e runs ──► regressions get caught ──► ranked-universe UI (M3.1)
                                                     ▲
Stripe annual ──► checkout works ────────────────────┘
```

Four of the five roots are **credential or budget decisions, not code**. That is
the honest shape of this quarter: the engineering is ahead of the provisioning.

---

## Risks

| Risk | Signal it's happening | Mitigation |
|---|---|---|
| LLM budget never decided | Precompute stays at 0 narratives past Sep | Force the decision in week 2; a "we stay free-tier and ship coverage-only" answer is acceptable, drift is not |
| Corpus migration copies the wrong docs | Tier 0 fills with confident irrelevant rules | Its README already warns; require human review of the first 20 chunks |
| Parity ceremony without parity | A twelfth "headline unchanged" PR note | M2.4 forces a choice |
| Doc sprawl outruns the wiki | Contradictory guidance across 60+ files | M2.5, and route new state into `docs/wiki-portal/` |
| Provisioning stays blocked on one person | Same three blockers in the Dec handoff | Each M1 item is <1 day; batch them into one session |

---

## See also

- `docs/pipeline-todo-blockers.md` — the 8 blockers, 3 now closed
- `docs/uni1.html` — the live post-#75 ledger with real Neon/gh/OpenRouter reads
- `docs/known-bugs.md` — the 19-item inventory, 7 still open
- `docs/wiki-portal/entity-ticker-universe-pipeline.md` — pipeline ground truth
- `docs/universe-scale-hydration.md` — the 6-step build order (5 done, 1 parked)
