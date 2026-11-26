# Plan: implement the cl24 scan and AI-feature proposals, verified on the frontend with OpenRouter

**Status: plan only. Nothing here is built or run.** Author: Claude (Sonnet 5.5). Verifier: pending.

This plan turns the S26 scan proposals and X26 AI-native follow-ons into shippable work in this repo. As of the 2026-11-18 01:30 log entry there are 52 scan proposals and 28 AI proposals, with 148 and 32 still to come. The [catalog](scan-expansion-s26-x26.md) in PR #403 holds only the first 22 and 22, so it is stale against the log. "Works" means: the new scans appear on the `/scans` pages with honest evidence labels, and at least one X26 assist runs on the frontend through OpenRouter with grounded answers and abstentions.

## 0. What the Captain's Log says now (read these first)

**Revised after the 01:30 and 01:33 entries.** An earlier version of this plan followed the 00:20 and 01:00 "docs-only" holds. The 01:30 entry supersedes them:

- Adam's 01:28 request moved the work from docs-only to small, verifiable code slices. The blanket holds are lifted for ordinary code and local fixture work. SPEC/E0 describes the evidence available; it does not forbid building.
- **Instinct owns coordination of the first slice and is the local creator** of `lib/shared/se1/compact-evidence.ts` and `__tests__/se1-compact-evidence.test.ts`, in an isolated snapshot based on portal `0e91834`. No pickup by Claude, Codex, or anyone else is claimed. **This plan must not create a parallel writer for those paths.**
- Whole-catalog duplicate reconciliation is **not** a prerequisite. Reconcile only the PR #36 and E80 rows that touch the slice you are building, and merge into an existing equivalent instead of counting another feature.
- First slice: a pure compact-evidence packet builder and validator (at most ten candidate rows in, at most five selected findings plus contrary or missing rows out). Next slice: one deterministic volume/liquidity scan over the existing shared feature frame.
- Retained limits: no paid models or paid fallbacks, no credit purchases, no live DB or admin changes, no migrations, no destructive actions, no new recurring cloud workloads, no notifications, no trades. Actual free-tier provider use still follows the existing grant and verified zero-cost, quota, and privacy conditions.
- The next implementation receipt must name a real artifact and a tested behavior, not another plan.

So the plan has three decision points for Adam, marked **DECISION** below. Only the model-call grant (DECISION 2) still blocks work, and only the OpenRouter phase.

## 1. What the repo already has (verified in this checkout)

| Piece | Where | Why it matters |
|---|---|---|
| Scan card type and seed cards | `lib/shared/se1-catalog.ts` (`ScanCard`, `SEED_CARDS`, `BUILT_FEEDS`) | New scans enter as cards. Only `alpaca_bars` is a built feed. Anything needing news, filings, quotes, vintages, or membership history stays E0 and shows on `/scans/gaps`. |
| Pure logic modules, no I/O | `lib/shared/se1/*.ts` (`ask`, `council`, `dossiers`, `explain`, `monitoring`, and others) | Where S26 logic goes. Same style: pure, fixture-tested. |
| Unit tests | `__tests__/se1/`, `__tests__/se1-*.test.ts` (vitest project `unit`) | Where S26 acceptance fixtures go. |
| Scan pages | `app/scans/` (`page.tsx`, `[id]`, `gaps`, `graph`, `dossier/[ticker]`) | The frontend surface. `ask.ts` is deterministic and makes no model call today. |
| Evidence components | `components/evidence/EvidenceBadge`, `ScanCardView` | Render the evidence level. |
| OpenRouter client | `lib/openrouter.ts`: `FREE_MODEL_CHAIN`, `callCouncilSeat(seat, prompt, apiKey, maxTokens)`, `SMALLEST_MODEL`, `fetchWithModelFallbackChecked` | The only sanctioned way to reach OpenRouter. Free-tier chain with fallback. |
| Gated public AI route (pattern to copy) | `app/api/council/public/route.ts` | Ticker-only input, server-built prompt, IP-hash quota, `flagLive("council_public_demo")`, 503 on failure. |
| Feature flags | `lib/flags.ts` (`FLAG_NAMES`, `FLAG_MODES`, `flagLive`) | New AI surface ships `off`. |
| Live AI tests | `__tests__/live/*.live.test.ts`, `_harness.ts` (`describeLive`, `HAS_KEY`) | Asserts invariants, never wording. Skips with no key. |
| Frontend e2e | `e2e/frontend/*.spec.ts`, Playwright project `frontend`, `npm run dev` web server | Browser proof. Depends on `auth-setup`. |

Env var names present in the main portal `.env.local` (names only, values not read): `OPENROUTER_API_KEY`, `IP_HASH_SECRET`, `ALPACA_API_KEY`.

**Not verified:** whether `/scans/*` is reachable without a login (Phase 4 step 1 checks), and whether `lib/public-demo` quota can serve a second route without a change (Phase 3 decides).

## 2. Sorting the 44 items by what they need

| Group | Items | Needs | Can ship as |
|---|---|---|---|
| **A. Bar-only scans** | S26-01, 02, 03, 07, 11, 13 to 22, and most of S26-23 to S26-52 (tops and distribution, trend-transition quality, volume and liquidity). Classify each as bar-only or feed-dependent when its slice starts. | Frozen daily bars (`alpaca_bars`), detector config version | Pure logic, fixture tests, cards at E0 until evaluated |
| **B. Scans needing feeds that do not exist** | S26-04 (vintages), 06 (availability times), 08 (quotes, costs), 09 (membership versions), 12 (dependency graph) | Data this repo does not have | Cards stay E0. Listed on `/scans/gaps`. No code beyond the card and a gap entry. |
| **C. Diagnostic scan** | S26-05, S26-10 | Run state and timestamps only | Pure logic, no new feed |
| **D. Deterministic frontend** | X26-04, 13 | Catalog and gap data | Pure logic plus a page. No model call. |
| **E. Model-assisted** | X26-01, 02, 03, 05 to 12, 14 to 20, 021, 022 | OpenRouter, grounded packets, abstention rules | Flag `off`, server-built prompts, live tests |

## 3. Phases

### Phase 0 — Ownership check and slice-level reconcile (read-only, no code)

Goal: before touching a path, confirm nobody else owns it, and mark which PR #36 or E80 rows overlap that slice. Do this per slice. Do not reconcile the whole catalog first.

Per slice, read the current log and open PRs for the paths you plan to edit. As of 01:33, `lib/shared/se1/compact-evidence.ts` and `__tests__/se1-compact-evidence.test.ts` belong to Instinct. Record branch, head, exact files, and the overlap decision in the PR body.

1. **Preflight.**

   ```bash
   cd ~/code/nuwrrrld-portal && git fetch -q origin main && gh pr view 36 --repo adamaslan/homebase --json state,headRefName -q '.state+" "+.headRefName'
   ```

   Expect: `OPEN docs/se1-200-scan-plan-2026-10-30`.

2. **Read PR #36's plan and the E80 list.**

   ```bash
   gh pr diff 36 --repo adamaslan/homebase --name-only
   ```

   Expect: the file list of the 200-scan plan. Open each and note the parent IDs (B2, C9, J9, and so on).

3. **Write the result** for the slice as a short table in this doc's section 7 (ID, duplicate of, keep or drop).

**DECISION 1 (Adam):** none needed to start. The log already lifted this gate. Confirm only if you want a different owner than Instinct for the first slice.

### Phase 1 — Offline logic, Group A, C, D (no model calls, no network)

One branch and one PR per wave, cut from `origin/main`, never from a feature branch. The worktree cap is 3 concurrent `nuwrrrld-portal` worktrees.

1. **Create the worktree.**

   ```bash
   cd ~/code/nuwrrrld-portal && git fetch -q origin main && git worktree add ~/code/.worktrees/nuwrrrld-portal/cl24-wave-a -b feat/cl24-wave-a origin/main && cd ~/code/.worktrees/nuwrrrld-portal/cl24-wave-a && test -f package-lock.json && npm ci
   ```

   Expect: `npm ci` finishes with no errors. Worktrees do not inherit `node_modules`.

2. **Slice order** (follows the 01:30 brief, then the earlier priority list):
   1. **Slice 1 (Instinct's): compact-evidence packet builder and validator.** Do not start it here. Acceptance from the log: a stale row cannot become current; mixed cutoffs cannot be compared like for like; over-budget input has an explicit omission manifest; invalid numbers and unknown IDs fail deliberately; the same normalized input gives the same packet and hash. This is the input the later model assists depend on.
   2. **Slice 2: one deterministic volume/liquidity scan** from batch 4 (S26-43 to S26-52), over the existing shared feature frame. Start with S26-43 (dollar-volume floor persistence), because its acceptance is easy to fixture: one huge print cannot hide routinely thin trading, and absent or zero volume is distinct from verified low volume. Add the narrow missing-state and point-in-time regression its real risk needs. Wire it into an existing caller only after reading that caller's contract.
   3. `S26-05` null-result diagnostic with `X26-04` and `X26-13`. State contract first: **no-hit, not-computed, failed, unsupported-history, absent-run**. This is *not* the existing three-state signal (not computed, computed negative, computed positive), so define the mapping in code and test it.
   4. `S26-11` shared-input cluster (S26-52 is its volume-lineage refinement), then `S26-02`, then `S26-01`.
   5. Remaining volume scans S26-44 to S26-51, then the bottom-formation and trend-transition scans, one module each.

3. **Per scan, the same four files:**
   - `lib/shared/se1/<scan>.ts`: pure function over frozen bars. It takes a decision cutoff and returns `supported / eligible / computed / missing` counts. It never fills missing history.
   - `__tests__/se1/<scan>.test.ts`: the acceptance fixture from the catalog. For example, S26-13 must reject a flag dated before the reclaim close.
   - An entry in `SEED_CARDS` in `lib/shared/se1-catalog.ts`, `evidence_level: "E0"`, `status` set to the existing spec value.
   - A gap entry if the feed is missing.

4. **Run the unit tests after each scan.**

   ```bash
   npx vitest run --project unit __tests__/se1
   ```

   Expect: all pass. Then the whole suite before the PR:

   ```bash
   npm run lint && npm run test:unit && npm run test:components
   ```

   Expect: exit code 0 for all three.

5. **Evidence level stays E0** until a held-out evaluation runs against a declared baseline, after costs. Do not raise it in this phase.

### Phase 2 — Frontend for the deterministic work (no model)

1. Extend the `/scans` index and `/scans/[id]` page to show the new cards. `generateStaticParams` already enumerates `SEED_CARDS`, so new cards get pages without route changes.
2. Add the coverage map from X26-13 as a section on `/scans/gaps`: runnable, partial, spec-only, with the missing feed named. A card alone must not make a question answerable.
3. Add component tests under `components/**/*.test.tsx` (vitest project `components`).

   ```bash
   npm run test:components
   ```

   Expect: pass.

4. **Browser check** (Phase 4, step 1).

### Phase 3 — OpenRouter on the frontend (Group E, flag `off`)

Start with one assist, not all 28. Recommended first: **X26-27** (compact participation explainer), because the log designs it around the compact packet from slice 1 and the volume scans from slice 2. It must wait for both. Until they exist, the only buildable assist is **X26-04** (explain no-hit versus not-computed versus failed), which has a small input, a checkable output, and a deterministic fallback.

**Design rules from the log (F1 profile, proposed targets, not provider guarantees):**

- Deterministic code screens and ranks. The model sees only a selected user question: at most five findings plus two contrary or missing rows. Never raw year-long bars, never the whole 2,000-symbol table.
- Start with a 1,500-input-token and 200-output-token cap, measured with the selected model's tokenizer. If mandatory provenance does not fit, return a deterministic summary or a smaller subset with an omission note, never silent truncation.
- The model output is a short enum choice (supported, contradicted, pending, unavailable) with up to two cited row IDs and at most 80 words. Code validates every enum, citation, number, and freshness field. The model does no arithmetic, identifies no tickers from prose, and places no trades.
- At most one inference per request and no automatic repair call. Deterministic text fallback on quota, timeout, schema failure, or support failure. No paid fallback.

**OpenRouter limits, as checked in the log at 01:24 (account-specific quota is unverified):** free variants document 20 requests a minute and 50 a day at the lower purchased-credit tier, and 1,000 a day at the higher tier. Free model availability varies, structured-output support is endpoint-specific, and local semantic checks are still required. Do not assume today's free list, a quality level, or unlimited throughput. The existing chain in `lib/openrouter.ts` already walks `FREE_MODEL_CHAIN`, so the route should keep using it.

**DECISION 2 (Adam):** confirm the model-call grant: free chain only, for live tests and a flagged route, with the zero-cost, quota, and privacy conditions verified first. The log keeps this boundary even though the code-and-fixture holds are lifted, and the free-tier limits above are shared with the rest of the app.

1. **Add the flag.** In `lib/flags.ts`, add `"scan_ai_assist"` to `FLAG_NAMES` and `scan_ai_assist: "off"` to `FLAG_MODES`. Ship `off`.

2. **Add the route** `app/api/scans/assist/route.ts`, copied from the `app/api/council/public/route.ts` pattern:
   - Input is a card id and a ticker only. No free text from a caller. The prompt is built entirely server-side from catalog rows and the Phase 1 diagnostic result.
   - 404 when `flagLive("scan_ai_assist")` is false.
   - Reads `OPENROUTER_API_KEY` from the environment. Never logs it.
   - Calls `callCouncilSeat("QUANT", prompt, apiKey, <max tokens>)`. `QUANT` is the smallest-model seat, so the prompt is written for the worst model in the chain.
   - Returns `{ answer, model, grounded_rows, abstained }`. If the Phase 1 diagnostic says missing or failed, return the deterministic explanation and **do not call the model**.
   - On failure return 503 and the deterministic fallback, never a fabricated answer.

3. **Quota.** Reuse `lib/public-demo` (`hashIp`, `checkAndIncrementDemoQuota`) only if it supports a second route name. If not, add a small route-keyed variant. **Check the file before writing the route.**

4. **Frontend control.** On `/scans/[id]`, render an "Explain this result" button only when the flag is live. It POSTs the card id and ticker, shows the answer with the model name and the cited rows, and shows the fallback text when the API returns 503 or `abstained`.

5. **Live test** `__tests__/live/scan-assist.live.test.ts`, written with `describeLive` from `_harness.ts`. Assert invariants only:
   - The answer is non-empty and arrives inside `SEAT_LATENCY_BUDGET_MS`.
   - Every number in the answer appears in the prompt's rows (grounding).
   - A fixture with no rows abstains and makes **zero** model calls.
   - It never asserts wording.

6. **Run it.** Preflight, then the test:

   ```bash
   cd ~/code/.worktrees/nuwrrrld-portal/cl24-wave-a && grep -c '^OPENROUTER_API_KEY=.' ~/code/nuwrrrld-portal/.env.local
   ```

   Expect: `1`. If `0`, stop. The test skips with no key.

   ```bash
   set -a && . ~/code/nuwrrrld-portal/.env.local && set +a && npx vitest run --project live __tests__/live/scan-assist.live.test.ts
   ```

   Expect: pass, or skip with a warning if the key is empty. The key is sourced from the file and never printed.

   Before enabling anything, confirm the free chain is alive. The chain has a history of retired slugs returning 404:

   ```bash
   set -a && . ~/code/nuwrrrld-portal/.env.local && set +a && npx vitest run --project live __tests__/live/model-chain.live.test.ts
   ```

   Expect: pass. A failure here is a chain problem, not a scan-assist problem.

7. **Next assists** only after the first works end to end, in the log's order: X26-28 (sparse narration selector, at most three candidate packets per request), X26-01 and X26-03, then X26-02 and X26-19. X26-14 (abstention-quality evaluation) comes last and needs its own approval for the frozen-case run. Never run an automatic 2,000-model-call sweep.

### Phase 4 — Prove it on the frontend

1. **Preflight: is `/scans` public, and does the server start?**

   ```bash
   cd ~/code/.worktrees/nuwrrrld-portal/cl24-wave-a && (npm run dev > /tmp/cl24-dev.log 2>&1 &) ; sleep 12; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/scans
   ```

   Expect: `200`. If `307` or `401`, the page is behind auth, so use the `frontend` Playwright project with `auth-setup` for browser proof.

2. **Check the new card page.**

   ```bash
   curl -s http://localhost:3000/scans/gaps | grep -c -i 'spec only'
   ```

   Expect: a number greater than 0 (E0 cards show the "Spec only" label from `EVIDENCE_INFO`).

3. **Check the assist route is dark by default.**

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/scans/assist -H 'content-type: application/json' -d '{"card":"se1.trend.golden_cross_recency","ticker":"AAPL"}'
   ```

   Expect: `404` while the flag is `off`.

4. **Enable the flag locally only**, by setting `scan_ai_assist: "live"` in a local, uncommitted edit of `lib/flags.ts`. Repeat step 3.

   Expect: `200` with `answer`, `model`, `grounded_rows`. A second call with a card that has no rows returns `abstained: true` and no model name.

5. **Browser proof.** Open `/scans/se1.trend.golden_cross_recency`, click "Explain this result", and confirm the answer, the model name, and the cited rows render. Then stop the server and click again: the fallback text must appear, not an error page.

6. **E2E spec** `e2e/frontend/scan-assist.spec.ts`, modeled on `nuai-fault-injection.spec.ts`: one test for the happy path and one for a forced 503. Run:

   ```bash
   npm run test:e2e -- --project=frontend e2e/frontend/scan-assist.spec.ts
   ```

   Expect: both pass. Revert the local flag edit afterward.

7. **Revert the local flag edit and verify it is dark.**

   ```bash
   git diff --stat lib/flags.ts
   ```

   Expect: no output.

## 4. Guardrails (every phase)

- No secrets in code, docs, or logs. Name variables only.
- No deploy, no `FLAG_MODES` change to `live` in a commit, no schema or OAuth change, no live provider or database writes from tests.
- Every model-assisted result carries its source and model name. Every scan result carries source, config version, decision cutoff, and the four denominators.
- Missing history is `unavailable`, never zero and never filled.
- Stage by explicit path. One unit of work, one branch, one PR. Wiki edits are the last commit on a branch, plus a line in `~/code/homebase/wiki-logs/portal/log.md`.
- The author does not merge. A different model reviews, as the cross-model rule requires.

## 5. Definition of done

- **Slice 1 merged:** the compact-evidence packet builder and validator (Instinct's), with its fail-then-pass fixtures and a real project build.
- **Slice 2 merged:** one deterministic volume/liquidity scan (start with S26-43) with its acceptance fixtures. Its card shows on `/scans` at E0.
- **One X26 assist works on the frontend through OpenRouter:** flag `off` by default, grounded answer with citations, abstains on missing evidence, falls back cleanly on 503, live test and e2e both pass.
- **No evidence-level claim above E0** without a held-out evaluation.
- Items in Group B are listed as gaps with the missing feed named.

## 6. What this plan does not do

- It does not run any scan against live data.
- It does not turn on any AI surface in production.
- It does not claim any S26 or X26 item is net-new until its slice's PR #36 and E80 rows are checked.
- It does not cover the remaining 148 scan ideas and 32 AI features the log (01:30) says will follow.
- It does not take over Instinct's slice 1 or claim any path the log assigns to another writer.

## 7. Slice-level reconciliation table (fill in per slice during Phase 0)

| ID | Duplicate of (E80 / PR #36 row) | Keep or drop | Notes |
|---|---|---|---|
| | | | |

**DECISION 3 (Adam):** who reviews. The cross-model rule needs a verifier from a different model family. Name the reviewer before the first PR opens.
