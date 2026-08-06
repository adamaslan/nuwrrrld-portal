---
date: 2026-07-30
type: concept
tags: [testing, vitest, ci, confidence, live-tests, quality]
sources: [../../vitest.config.ts, ../../package.json, ../../test/live-setup.ts, ../../.github/workflows, ../../.githooks/pre-commit]
---

# Concept — Test Strategy (Three Layers, One Default)

How the portal decides what to test, where, and what runs by default. The
guiding rule: **a test that can fail for reasons unrelated to the code must not
be able to block the default suite.**

## The pattern

`vitest.config.ts` defines three *projects*, not one suite. The split is
deliberate — each layer trades speed for realism, and only the fast, hermetic
layers run by default.

| Project | Environment | Matches | Runs by default? |
|---|---|---|---|
| `unit` | `node` | `__tests__/**/*.test.ts` (excludes `__tests__/live/**`) | ✅ |
| `components` | `jsdom` (`test/setup.ts`) | `components/**/*.test.tsx`, `app/**/*.test.tsx` | ✅ |
| `live` | `node` (`test/live-setup.ts`) | `__tests__/live/**/*.live.test.ts` | ❌ opt-in |

`npm test` = `unit` + `components`. `live` is reachable only via
`npm run test:live` / `test:all`.

**Why `live` is quarantined.** Those tests make real model calls against the
free tier. They are slow and *legitimately* flaky — not badly written, but
subject to an external quota that this repo does not control
([[concept-free-tier-resilience]]). The project config encodes that reality:
`fileParallelism: false` (free providers rate-limit on concurrency),
`testTimeout: 120_000`, and `retry: 1` to absorb the 429s the fallback chain is
*meant* to absorb. `test/live-setup.ts` loads `.env.local` and — importantly —
**skips loudly when no key is present rather than failing or silently
passing**, so "no key" never masquerades as "green."

The three layers answer three different questions:

1. **unit** — is the pure logic right? Parsers, mappers, validators, policy
   functions. Fast, no I/O, no DB. This is where
   [[entity-signal-data-plane]]'s `signal-policy`, `subscription`'s metadata
   parser, and the Hold/Fold mapper are pinned.
2. **components** — does the UI render and behave? jsdom + Testing Library.
3. **live** — do the *external contracts* still hold? Model chain reachability,
   SSE streaming shape, verdict-JSON parseability. These are contract probes
   against a moving third party, not regression tests.

A fourth, separate lane exists for the DB: `test:integration` runs
`__tests__/signal-queue.integration.test.ts` against a real Neon branch in CI.

## Where it appears

- `vitest.config.ts` — the three-project definition
- `package.json` scripts — `test`, `test:unit`, `test:components`,
  `test:live`, `test:integration`, `test:all`
- `test/setup.ts`, `test/live-setup.ts`, `test/reducedMotion.ts`
- `.github/workflows/integration-tests.yml` — the Neon-branch DB lane
- `.githooks/pre-commit` — a *secret* guard (gitleaks + pattern fallback), not
  a test gate; it blocks credentials in staged changes
- Pinned behavior lives in `__tests__/` for logic and colocated `*.test.tsx`
  for components

## What would actually raise confidence

Ordered by value per unit of effort, grounded in the gaps below:

1. **Run the default suite in CI.** Today nothing does (see contradictions).
   One workflow calling `npm test` is the single highest-value change on this
   page.
2. **Commit the untracked tests.** 19 of 29 test files are untracked — the
   work exists but isn't shared or enforceable.
3. **Add a lint gate that works.** `npm run lint` currently crashes repo-wide
   on an ESLint flat/eslintrc config conflict, so no file is linted at all.
4. **Pin every fixed bug with a unit test at the lowest layer that can catch
   it.** Recent fixes did this well (`stripe-checkout`, `subscription`
   malformed-metadata, `brief` prompt degradation) — keep it habitual.
5. **Treat `live` failures as a signal about the world, not the code.** Read
   the error before debugging: a whole-chain 429 is a quota fact
   ([[entity-openrouter-client]] known-failure #3), not a regression.

## Contradictions / tensions

> ⚠️ Contradiction: `.github/workflows/integration-tests.yml:13` states "The
> default unit suite (`npm test`) still runs everywhere and needs none of
> this" — but **no workflow runs it**. `grep -r "npm test" .github/workflows`
> matches only that comment. The 180-test unit suite and the component suite
> are local-only; CI runs the integration lane and two crons. The assumption
> the comment encodes is not true, so a regression in pure logic reaches
> `main` unchallenged.

> ⚠️ Contradiction: 19 of 29 test files are **untracked** — including all
> three `__tests__/live/*`, every `components/landing/*` test, and
> `components/a11y.test.tsx`. Tests that aren't committed can't gate anything
> and are invisible to every other clone. This is the same
> written-but-never-committed failure that repeatedly lost wiki content, and
> it is why `wiki-guard` now checks for it (`~/.claude/scripts/wiki-guard.mjs`)
> — no equivalent guard exists for tests yet.

> ⚠️ Contradiction: `package.json` declares `"lint": "eslint"`, but running it
> throws `TypeError: Converting circular structure to JSON` from
> `@eslint/eslintrc` on *every* file, including ones untouched for weeks. Lint
> is nominally part of quality here and actually enforces nothing.

> ❓ Open question: component tests have shown timing flakiness
> (`StatCounter` animation assertions failed in one run, passed in the next).
> Is the fix fake timers, or are these tests asserting on animation timing
> that shouldn't be asserted at all? Not yet decided.

> ❓ Open question: there is no coverage measurement, so "well tested" is
> currently a feeling rather than a number. Worth adding only if it drives
> decisions — coverage as a gate tends to reward trivial tests.

## See also

- [[concept-free-tier-resilience]] — why the `live` project must stay opt-in
- [[entity-openrouter-client]] — what the live model-chain tests actually probe
- [[entity-signal-data-plane]] · [[entity-billing]] — the logic the unit layer pins
- [[concept-graceful-degradation]] — the behavior most worth pinning with tests
- `gcp3-mobile/docs/wiki-mobile/concept-test-strategy.md` — the mobile counterpart (no test tooling at all)
