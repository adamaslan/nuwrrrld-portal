# diff1 review and fix pass, 2026-11-19

Summary of the diff1 review of the open nuwrrrld-portal (NWF) PRs, the fixes made for the findings, and where each fix lives.

## Review coverage

- 27 open PRs. Three already had a diff1 review at their current head: #326, #337, #344.
- 24 PRs were reviewed in this pass. Seven had findings and received diff1 comments on the reviewed head.
- Clean or partially reviewed PRs received no comment. Coverage is stated per PR below.
- Reviewer for every comment and commit: Claude Haiku 5.5. No subagents were used.

## Findings and fixes

| PR | Branch | Reviewed head | Fix commit | Finding | Verification |
|---|---|---|---|---|---|
| #372 | `docs/nwf4-modal-audit-20261113` | `42a2cdb2` | `470d723` | `tick` hard-coded `shadow-batch`, which dropped the live-price poller on deploy. The audit says keep it until an alternate writer is verified. | Profile now comes from `NWF4_CADENCE_PROFILE`, default `legacy`, schedule every minute. 90/90 Python tests. |
| #402 | `feat/modal-batch-scoring-offline-2026-11-17` | `40bbd36a` | `015866d` | Backlog launcher passed `finalize_batch=True` regardless of `NEWS_BATCH_SCORING`. | Launcher passes `batch`. 119/119 and 8/8 Python tests. |
| #408 | `feat/cl24-price-impact-proxy` | `94bc604f` | `ab10746` | Split band was exclusive at its edges, so an exact 2-for-1 split (ratio 0.5) was kept. The existing test passed for the wrong reason. | Band is inclusive. Added an exact-edge test. 9/9 vitest. |
| #407 | `feat/cl24-volume-scans-batch` | `c7d413c3` | `af870a9` | Breakout candidates with a missing baseline close were dropped silently. | Counted as `excluded_missing_baseline`, with a test. Also corrected a pre-existing wrong expectation in `confirmationLag` tests. 18/18 vitest. |
| #356 | `fix/restyle-legal-20261110` | `7d9fcc3f` | `4886f20` | Brand-mark font size dropped from 12px to 10px. | Restored to 12px, and the test asserts it. 4/4 vitest. |
| #335 | `diag/seat-attempt-logging` | `0b55f128` | `e32362a` | Per-attempt diagnostics used `console.error` in production. | Ported the helper from #398 with identical text so the hunks merge cleanly. Tests stub `CI` and `NODE_ENV`. 50/50 vitest. |

Not fixed:
- **#355** (`app/dashboard/dashboard.css`). The root `grayscale` filter on the account popup and profile may strip provider logos. This is unverified in a browser, and the fix would remove the monochrome filter the PR is built around. Needs a rendered check first.

## Dependencies and conflicts

- #335 and #398 both touch `lib/openrouter.ts` and `__tests__/openrouter-fallback.test.ts`. #335 now carries the same helper text as #398. Merge one first; the other rebases.
- #372 and #402 both touch `deploy/aws-modal-news/modal_app.py` and `news_core.py`. Merge one first; the other rebases.
- #335 also overlaps #350 on `lib/openrouter.ts`.

## Not in this pass

- Coverage gaps from the review: #343 (only the replay route, `proxy.ts` and the loader were read), #401, #345, #403, #399, #338 were not reviewed in depth.
- Tests were not run for the full suites or with a TypeScript typecheck. Only the test files touched by each fix were run.
- Rebases were not done. #372 and #356 are far behind `origin/main`; rebasing is a separate step.

## Notes on the diff1 comments

Diff1 comments on #372, #402, #408, #356, #335, #355 and #407 name the reviewed head SHA. The fix commits above land on top of those heads, so the comments now point at older commits.
