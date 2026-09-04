# TODO — September 4, 2026

Consolidated blockers and engineering work from CodeRabbit findings on PR #97 (feat: MOO ETF council simulation) and prior session notes.

## CodeRabbit findings from PR #97 — council simulation + MOO ETF investment model

### Critical (API surface)

#### 1. Add end-to-end timeout to `/api/council` requests
**File:** `lib/openrouter.ts:408`  
**Issue:** Three sequential model calls (T1 seat, grounded brief, T2 verdict) have no wall-clock limit. A stalled call can hang the entire route for 300s+.  
**Fix:** Wrap all three calls in a single `AbortSignal.timeout(...)` and propagate it, so any stall aborts the whole chain at a controlled deadline (recommend 20s).  
**Why:** Affects all `/api/council/*` callers. Needs testing on both `/sample` and `/deliberate`.

#### 2. Add MCP fetch timeout to `/api/council/sample`
**File:** `app/api/council/sample/route.ts:55` (`fetchLiveSignal`)  
**Issue:** Fetch to MCP backend has no timeout. A stalled connection can wait for runtime timeout before returning null.  
**Fix:** Add `AbortSignal.timeout(5000)` to the fetch and treat abort as "signal unavailable" (already caught by existing error handler).  
**Why:** Unblocks `generateSample()` to fall back to general-market prompt on timeout.

#### 3. Remove temporal label from cached council sample
**File:** `app/page.tsx:511`  
**Issue:** The council sample is cached for 21,600 seconds (6 hours), but labeled "today". Label becomes stale after midnight.  
**Fix:** Render the generation date from `council.generatedAt` instead of "today", or remove the temporal label entirely.  
**Why:** Correctness — avoid misleading the user on how fresh the data is.

### Important (simulation correctness)

#### 4. Require verdict quorum in MOO headroom simulation
**File:** `docs/moo-council-run/run_council_headroom.mjs:141`  
**Issue:** The script parses responses but writes artifact even if all three calls fail or return unparseable data. Verdict is marked `parse_error` rather than invalid.  
**Fix:** Discard invalid samples, require majority (≥2 of 3 valid verdicts) before deriving direction and confidence. Fail or mark unavailable when no quorum.  
**Why:** Affects confidence scoring. Needs validation against known-good runs.

#### 5. Use executable entry price in MOO simulation returns
**File:** `docs/moo-council-run/sim_moo.py:53`  
**Issue:** Returns are calculated from *closing* price, not entry price after signal. Entry timing affects the realistic return calculation.  
**Fix:** Use the price at signal time, not EOD close, for entry.  
**Why:** Simulation fidelity — entry price matters for return accuracy.

### Medium priority (robustness + config)

#### 6. Handle empty scan result in `scan_moo.py`
**File:** `docs/moo-council-run/scan_moo.py:14`  
**Issue:** If `analyze()` returns no records, `res` is undefined and crashes.  
**Fix:** Check for empty result and return gracefully.

#### 7. Fix locrun dependency in `scan_moo.py`
**File:** `docs/moo-council-run/scan_moo.py:2`  
**Issue:** Import statement references undefined module `locrun`.  
**Fix:** Verify import path or add to PYTHONPATH.

#### 8. Align holdings output format with regeneration workflow
**File:** `docs/moo-council-simulation-todo.md:311`  
**Issue:** Output format from `run_council_headroom.mjs` doesn't match what regeneration expects.  
**Fix:** Align JSON schema with regeneration workflow.

### Nitpick (non-blocking)

#### 9. Test coverage for OpenRouter fallback
**File:** `__tests__/openrouter-fallback.test.ts`  
**Issue:** Minor test improvement.  
**Fix:** Skip for now (covered by existing fallback logic).

---

## Prior session blockers — still open

### Manual setup TODOs (audited 2026-09-04)

**Status:** Most claims in docs/manual-setup-todo.md are stale. Integration CI is green. Most secrets set.

**Real blockers still open:**
- **Stripe webhook secret in Vercel prod** — Still placeholder (`whsec_pla...`). Local has real value; needs push to Vercel.
- **CRON_SECRET unset** — Causes `followed-tickers*` routes to 503. Fix: `openssl rand -hex 32`.
- **GCP Workload Identity** — Not provisioned. E2E suite fails at "Authenticate to GCP".
- **Pipeline routes missing** — 4 afternoon-pipeline routes (signals-refresh, theses-score, council-run, council-validate-distribution) absent from repo.

### Clerk auth TODOs

**P0 — Enforce MFA** in dashboard before admin console can mutate.  
**P1 — Session lifetime + inactivity timeout** not yet configured on prod instance.

**P1 — Verify Allowed Subdomains for `financial.nuwrrrld.com`.**
Dashboard → prod instance → Domains → Allowed Subdomains. The 2026-09-02
cutover confirmed `financial.nuwrrrld.com` is in `allowed_origins` (the
Backend-API allowlist), but that is not the same setting as the web
subdomain control — Allowed Subdomains hasn't been explicitly checked. See
`docs/wiki-portal/decision-clerk-subdomain-without-satellite.md`.

**P1 — Set `authorizedParties` in `middleware.ts`.**
`clerkMiddleware` is not currently passed `authorizedParties`, so Clerk
trusts any subdomain of the root domain by default — wider than intended.
Add as a second argument (don't replace the existing callback form):

```ts
export default clerkMiddleware(
  async (auth, req) => {
    // ...existing route-protection logic, unchanged...
  },
  { authorizedParties: ["https://financial.nuwrrrld.com"] },
);
```

See `docs/clerk-free-plan-best-practices.md` §2 for the full reasoning.

### Market snapshot work

**Proposed:** Demote live fetch, promote cached confluence score. **Status:** Not started.

---

## Cross-repo parity — mobile ↔ web

**Known drifts:**
- `lib/shared/signal-policy.ts` — Web added 25 lines; mobile not ported. Blocks PR #101 (shared-drift-check fails).
- `lib/subscription.ts` — Drifted; needs unified tier logic.

**Attribution.ts sync follow-ups (2026-09-01, mobile PR #39 merged)**

Mobile PR #39 (`adamaslan/gcp-expo1`, `a8a8e92`) merged the `attribution.ts` mirror + mobile parity-wiki reconciliation. Parity headline ~62% (both wikis agree). Still open:

- **[Portal drift-guard `PAIRS` entry](docs/todo-attribution-sync-followups.md)** — HIGH, trivial (one line). Add `{ path: "lib/shared/attribution.ts", normalize: null }` to `scripts/check-shared-drift.mjs`. Both copies already byte-identical on `main`; mobile side already has it via PR #39.
- **Mobile attribution-capture path** — MEDIUM, feature work. Module adopted but unconsumed; nothing builds/persists a touch. Needs a first-authenticated-load client call + mobile route. (sync-requirements priority #8.)
- **Mobile consent adoption** — HIGH (compliance). `consent.ts`/`legal-consent.ts` still portal-only (PRs #77/#78); mobile runs `analytics.ts`+`sentry.ts` with no gate. GDPR/CPRA bind the app. Portable now (only the `prefs.ts` seam). (sync-requirements priority #7, #1 by ROI.)
- **Mobile DSAR path** — MEDIUM (compliance). Portal PR #78 shipped `/api/privacy/{export,profile,delete,rectify}` web-only; same account has no mechanism on mobile. Build or record a web-only decision with an in-app link. (sync-requirements priority #9.)

---

## Notes

- End-to-end deadline (item 1) is foundational. Do that before anything calling `/api/council/*`.
- Session gaps stub shows multiple sessions ended on `feat/universe-hydration` without handoff. That branch may have stale work.
- This doc consolidates CodeRabbit findings, audits, and session context. Update in place.

---

## PR #101 status update (2026-09-04, post-#97 merge)

**Rebased onto main after #97 merged.** Clean rebase, zero conflicts — the `log.md`/`concept-mobile-web-parity.md` overlap with #97 was already resolved when #97's docs landed on main. Pushed to `feat/signal-engine-phases-1-3` (new head `725e693`).

**Now `MERGEABLE`.** Still blocked on:
- `shared-drift-check` failing — `lib/shared/signal-policy.ts` has drifted from its `gcp3-mobile` counterpart (25 new lines added on web side only). Needs a cross-repo decision (port to mobile, or extend the seam) before merge — not a lint suppression.
- CodeRabbit review — was rate-limited pre-rebase; a fresh review should fire automatically now that new commits landed. Check `gh pr checks 101` for review state before merging.
