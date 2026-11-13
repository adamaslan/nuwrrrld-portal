# se1 features: skill-pass review

Reviewed: PR #346 head `8b2694a` (`feat/w0-evidence-foundation`), the 20 features in `lib/shared/ai-features.ts`, and the scan pages, components, and logic modules they use.
Method: five passes from the `optimized-prompt-suite` (codebase-build-refactor, testing-perf-cost, ai-code-debugging, feature-gating-safety, evidence-gated-delivery). Each claim below is marked PASS, FAIL, or UNVERIFIED, with its location.

## Summary

| # | Pass | Result | Finding IDs |
|---|---|---|---|
| 1 | Change impact (codebase-build-refactor) | PASS, with one **FAIL** on unwired features | F3, F4 |
| 2 | Test quality (testing-perf-cost) | PASS after one added test; one equivalent mutant left | F9 |
| 3 | AI-code audit (ai-code-debugging) | **FAIL** on provenance; fixed in PR B | F1, F2, F5–F8 |
| 4 | Feature gating (feature-gating-safety) | PASS: no sensitive surface touched | — |
| 5 | Evidence (evidence-gated-delivery) | Listed per claim below | — |

## 1. Change impact

Non-test importers of the new modules are the 8 files under `app/scans/`, `app/llms.txt/`, and `components/evidence/`. Nothing else in `app/`, `components/`, `lib/`, `proxy.ts`, or `scripts/` imports them. Checked with `grep -rlw` per export.

- **Certain blast radius:** `app/sitemap.ts` (one new entry, `/scans`). No other existing file changes.
- **Route collisions:** none. `public/` has no `llms.txt`. `/scans` and `/llms.txt` are not in `proxy.ts`'s matchers, so they are public, which is intended.
- **Mobile dependents:** none. `gcp3-mobile/lib/shared/` has no se1 or ai-features files. `scripts/check-shared-drift.mjs` does not list them, so no CI gate watches them. **PASS** for "no mobile impact today"; **UNVERIFIED** for "future drift guarded".
- **Tests that catch a break:** `se1-catalog`, `se1-dossier`, `llms-txt`, `se1-review-fixes`. **No test** renders the `/scans` pages or checks that an unknown `/scans/[id]` returns 404 (F9).

## 2. Test quality (mutation check)

Ten deliberate breaks, each run against the three test files, then restored. The restored files were compared byte for byte with backups.

| Break | Before | After |
|---|---|---|
| M1 quiet-hours start boundary `>=` → `>` | survived | caught (test added for hour 22 and a same-day window) |
| M2 ticker cap `>=` → `>` | caught | caught |
| M3 F2 picks weakest level | caught | caught |
| M4 J2 drops unknown-citation check | caught | caught |
| M5 J5 flat-series guard removed | survived | **equivalent mutant**: `pearson` already returns null for flat series, so no test can kill it |
| M6 F2 empty backing → E4 | caught | caught |
| M7 G5 no pair ordering | caught | caught |
| M8 A7 evidence filter ignored | caught | caught |
| M9 G6 gap list never blocks | caught | caught |
| M10 G9 provenance fails open | caught | caught |

**PASS**: all 9 killable mutants are caught after the M1 test; M5 is the one equivalent mutant. Test-first was **not** followed for the original code. The tests were written after it, and the evidence skill asks for failing tests first. The fixes in PR B are test-first.

## 3. AI-code audit

Checked for hallucinated APIs, swallowed errors, masking fallbacks, weak tests, and layer violations.

- **F1 (high, FAIL, fixed in PR B):** `components/evidence/ScanCardView.tsx` passed `as_of: "not run"` to `ProvenanceFooter`. The footer only checks for a non-empty string, so an unrun scan rendered `Source … · as of not run · scan v1.0.0`. Probed with a temporary test (removed): `formatProvenance({… as_of: "not run" …})` returns that sourced-looking line. This breaks the fail-closed rule (G9). **Fix:** `cardProvenance()` in `lib/shared/se1-catalog.ts` leaves `as_of` empty for unrun cards, so the footer shows "Unsourced: missing as_of."
- **F2 (medium, FAIL, fixed in PR B):** nine features (A3, B7, B9, C4, D6, D9, F2, J2, J5) were marked `web_only`, but no route or component renders them. Marked `logic_only` now, with a new status value and a pinning test.
- **F3 (medium, recorded, not fixed):** `ScanCitations` (A3) has no caller. A3 is not live. **Decision needed:** wire it into a rendered finding, or move it to `file-archive/` with an `ARCHIVED:` header. Not deleted, per the archive rule.
- **F4 (medium, recorded):** the dossier logic (`diffDossiers`, `dossierToMarkdown`, `missingEvidenceSection`, `detectContradictions`, `decideAlert`, `holdFoldConfidence`, `checkFaithfulness`, `nearDuplicates`) has no caller outside its tests. Wiring waits for the se1 results store (plan decision D1).
- **F5 (low, recorded):** `nearDuplicates` silently skips series of different lengths or under 5 points. It returns no result and no error, so a caller cannot tell "no duplicates" from "could not compare."
- **F6 (low, recorded):** `decideAlert` does not validate `localHour` (0–23). An out-of-range value silently changes quiet-hours behavior.
- **F7 (low, recorded):** `checkFaithfulness` splits sentences on any `.`, `!`, or `?` followed by whitespace. Abbreviations such as "e.g. 5" split a sentence in two.
- **F8 (low, recorded):** `ScanCardView` imports `EVIDENCE_INFO` in a second statement. Style only.
- **Checked and not a defect:** `splitCitations` alternation (`vol` before `vola`) matches correctly, verified by test. `/llms.txt` as a static route handler is valid for Next's `force-static`.

## 4. Feature gating

Files in the PR: `app/sitemap.ts`, `app/scans/**`, `app/llms.txt/**`, `components/evidence/**`, `lib/shared/se1-*.ts`, `lib/shared/ai-features.ts`, and tests. None touches auth, Clerk, Stripe, webhooks, rate limits, migrations, secrets, or `proxy.ts`. **PASS: no sensitive surface, so no confirmation gate applies.**

Residual, **UNVERIFIED**: the new pages are public and not behind a flag. They show only spec content today. If the results store later feeds them real rows, they should go behind a flag first.

## 5. Evidence, per claim

| Claim | Status | Location |
|---|---|---|
| Unit suite passes after PR B | PASS (local) | `npx vitest run --project unit`: 104 files, 1235 tests passed, 9 skipped |
| Components suite passes after PR B | PASS (local) | `npx vitest run --project components`: 22 files, 135 tests passed |
| Provenance defect is real before fix | PASS (local probe, deleted after) | `formatProvenance` with `as_of: "not run"` returns a sourced line |
| Regression tests fail before fix | PASS (local) | `__tests__/se1-review-fixes.test.ts`: 2 failed before the fix |
| Regression tests pass after fix | PASS (local) | same file: 21 tests across 3 files pass after the fix |
| Typecheck clean on new files | PASS (local) | `npx tsc --noEmit -p .`: 0 errors in new files. `lib/firestore-admin.ts` has 2 errors (missing `firebase-admin`), a file no change here touches. **Not checked against main** |
| Lint clean on touched files | PASS (local) | `npx eslint …`: exit 0 |
| Pages render in a browser | **UNVERIFIED** | no `next build` or browser run |
| CI result | **UNVERIFIED** | depends on CI for each PR |
| Feature flag ON/OFF | N/A | no flag exists for these pages (see §4) |
| Mobile parity recomputed | **FAIL** | `concept-mobile-web-parity.md` not updated in either wiki (see PR #346) |
