# Scan expansion S26 and AI-native follow-ons X26: proposal catalog

**Status: SPEC / E0 for every row.** Nothing here is built, run, or measured. The IDs are new proposal references. They are not additional shipped-feature counts, and they are not evidence that any implementation is unique.

**Source:** Captain's Log (homebase#24 Google Doc, "cl24") entries dated 2026-11-18 00:20 and 01:00 America/New_York. Both entries say that no scan execution, model or provider calls, notifications, code changes, deployment, account changes, or spending is authorized.

**Relationship to existing work**

- [PR #13 (homebase)](https://github.com/adamaslan/homebase/pull/13): the scan encyclopedia. S26 items refine its families (support, momentum, volume, horizon, shadow evaluation).
- [PR #36 (homebase)](https://github.com/adamaslan/homebase/pull/36): the 200-scan taxonomy and 100-feature roadmap. Parent IDs below point into that roadmap.
- E80 and the 2,000-symbol roster are separate. Reconcile exact overlaps before any item is assigned for implementation.

## Shared rules for every row

- Use one approved bar snapshot per run. Do not fetch per idea.
- Every result records: source and config version, decision cutoff, membership version, supported / eligible / computed / missing denominators, adjustment basis, and unresolved lookahead guards.
- Missing history stays unavailable. It is never filled and never treated as zero.
- Thresholds and windows are starting hypotheses. Freeze them before held-out evaluation.
- Measure forward outcomes against a declared baseline, after costs, and against false positives.
- No current ticker is claimed to match any pattern.

## S26 scan proposals (22)

| ID | Name | Parent / refines | Acceptance check |
|---|---|---|---|
| S26-01 | Signal fragility scan | J1 evidence harness | Fixed fixtures replay identically; no robustness percentage when input uncertainty is ungrounded |
| S26-02 | Remove-one-detector scan | C3, J5 | Single-family dominance is detectable; correlated votes are not described as independent |
| S26-03 | Horizon-disagreement scan | Encyclopedia horizon scan (§5) | Contradictory horizons are reported without collapsing to one average |
| S26-04 | Data-vintage revision scan | B7 dossier diff | A corrected bar produces a correction notice, not a new historical trade |
| S26-05 | Null-result diagnostic scan | J9 coverage | All-empty inputs never yield a valid NEUTRAL or HOLD |
| S26-06 | Session-cutoff contamination scan | J1, existing point-in-time guard | An injected future item fails before scoring |
| S26-07 | Baseline-survival scan | Shadow evaluation (§11) | A randomized fixture never promotes itself by picking the best window |
| S26-08 | Liquidity and cost break-even scan | F7 strategy backtest | A gross-positive, cost-negative fixture stays negative after costs |
| S26-09 | Universe-selection sensitivity scan | J1, J9 | Survivor-only runs keep a bias label; no invented filler tickers |
| S26-10 | Contradiction freshness scan | D6, G5 | Stale or opposite readings never qualify as a contradiction alert |
| S26-11 | Shared-input cluster scan | J5, C1 | Ten copies of one signal count as one support group |
| S26-12 | Invalidation blast-radius scan | J1, B7, D7 | A seeded invalidation reaches all known dependents without deleting history |
| S26-13 | Failed-breakdown reclaim | Support break and retest (§1 to §5 family) | Level is computed from prefix bars only; no flag before the reclaim close |
| S26-14 | Second-low selling-pressure contraction | RSI divergence family | A lower low with heavier selling is not narrated as exhaustion; pivot confirmation is delayed explicitly |
| S26-15 | Base-width versus depth scan | Support scan | A monotonic falling fixture does not become a base just because volatility shrinks |
| S26-16 | Post-capitulation stabilization | ATR and volume flags | No bottom timestamp on the capitulation day; a failed quiet period cancels the candidate, never rewrites history |
| S26-17 | Higher-low with breadth confirmation | Sector breadth | Stale or missing peers cannot inflate breadth; the ETF is not its own holdings universe |
| S26-18 | Downside follow-through failure | S26-13 contrast | An incomplete three-session window is pending; overlapping events are deduplicated under a frozen rule |
| S26-19 | Relative-strength bottom lead | Sector residual | A market-wide rebound without stock-relative improvement does not qualify |
| S26-20 | Gap-down repair ladder | Gap context | Split or corporate-action adjustment cannot create an artificial gap; partial recovery is not a full reversal |
| S26-21 | Repeated downside rejection with close recovery | Price-action family | Zero-range bars and unadjusted split bars are rejected; no claim about who the buyers are |
| S26-22 | Bottom-pattern disagreement register | S26-10, S26-11 | Missing rows cannot yield neutral or a high-confidence bottom; no majority vote is presented as calibrated probability |

## X26 AI-native follow-ons (22)

Each entry gives a small model a bounded tool or result and a measurable acceptance check. Most also state an explicit stop condition. None is implemented. None is a model call.

| ID | Name | Parent / refines | Acceptance check |
|---|---|---|---|
| X26-01 | Evidence-budget planner | A2, I5, S26-11 | Never runs an unsupported or over-budget recipe; payload size and correctness are measured against the full payload |
| X26-02 | Stability-aware idea ranking | B2, C9, S26-01 | An unstable high-score fixture is labeled fragile, not promoted |
| X26-03 | Dependence-aware Council packet | C1, C3, S26-02, S26-11 | Duplicating one row cannot inflate the independent-support count |
| X26-04 | Honest neutral explainer | A9, G6, S26-05 | A missing-indicator fixture cannot become a neutral market opinion |
| X26-05 | Corrected-data briefing | B7, D7, S26-04 | Shows the correction delta; past advice is not rewritten as if it were known then |
| X26-06 | Cutoff-safe answer compiler | A1, C3, J2, S26-06 | Future timestamps cannot appear in the narrative; no causal claim from coincident news and price moves |
| X26-07 | Evidence disagreement referee | A4, C2, D6, S26-10 | Stale conflicts produce a refresh or gap response, not a forced bull-versus-bear debate |
| X26-08 | Horizon negotiation assistant | A2, A5, B2, S26-03 | Ambiguous intent triggers one clarification; no hidden horizon change |
| X26-09 | Cost-aware paper idea explainer | F5, F7, S26-08 | Gross return, cost scenarios, and break-even are shown separately; unprovided costs stay unknown; no live-order path |
| X26-10 | Coverage-sensitive portfolio critique | E1, E3, E5, S26-05, S26-09 | Missing assets are not treated as zero risk; private weights stay tenant-isolated |
| X26-11 | Survivorship challenge card | B1, C5, J1, S26-09 | A current-universe backtest cannot be described as delisted-inclusive |
| X26-12 | Evidence correction inbox | D7, G3, S26-12 | Proposed corrections are shown; no alerts are sent automatically; historical versions remain available |
| X26-13 | Scan-to-question coverage map | G7, J9, S26-05 | A catalog card alone cannot make a question answerable; unsupported filters fail before execution |
| X26-14 | Abstention-quality evaluator | J2, J3, S26-05, S26-06 | Reports false-confident and unnecessary-abstention rates on frozen cases; model calls need separate approval |
| X26-15 | Same-evidence model comparison | J3, S26-11 | Inputs are equivalent; no silent fallback; factual claims are checked against exact rows; no provider calls from this plan |
| X26-16 | Claim-level counterexample finder | C3, C5, J2, S26-02, S26-07 | Retrieves actual conflicting cases from held-out evidence, not invented devil's advocacy; no applicable counterexample produces an explicit gap; each case links outcome, cutoff, and version |
| X26-17 | Repair-or-stop tool coach | A2, I2, S26-05 | At most one schema-valid repair; no alternative provider or feed chosen without scope; no fabricated success after failure |
| X26-18 | Recipe-change impact preview | I5, B7, F3, S26-12 | Dry preview has zero persistence or execution effects; prior recipe identities stay immutable |
| X26-19 | Novelty-with-evidence idea composer | B1, J5, S26-02, S26-11 | Duplicated indicators do not count as novelty; observation, inference, and untested mechanism are kept separate |
| X26-20 | Insight acceptance scoreboard | J1, J6, J9, S26-07 | Scores grounded-claim precision, missed contradictions, coverage, and measured cost; no auto-promotion or deletion |
| X26-021 | Bottom-hypothesis workbench | B2, B4, C9, C3, S26-13 to S26-22 | No confirmed lows yields pending or unavailable, not an invented bottom; technical evidence cannot establish valuation or a buy call |
| X26-022 | Confirmation-delay tutor | A9, C3, A3, S26-13, S26-14, S26-16, S26-21 | A replay answer cannot use pivot-confirmation bars before their close; the same frozen input gives the same timeline |

## Priority order (from the Captain's Log)

1. S26-05 with X26-04 and X26-13: honest-input foundations.
2. S26-11 with X26-01 and X26-03: help smaller models.
3. S26-01 and S26-02 with X26-02 and X26-19: stronger ideas.

The Captain's Log says the order must be reconciled against E80 duplicates before anything is claimed as net-new. It also says success means "useful grounded reasoning on the same evidence with honest failures and measured cost," not a count of rows marked done.

## Progress recorded in the log

- After the 01:00 batch: 22 of 200 scan proposals and 22 of 60 AI-feature proposals. Remaining: 178 scan ideas and 38 AI features. The log says it will continue with top and distribution sequences, with separate short-sale and borrow limits.
- This document covers the 44 IDs recorded so far. It does not extend the inventory.

## Open items

- Reconcile each S26 and X26 item against E80 and PR #36 for duplicates before assigning implementation.
- Confirm the source of each parent ID (B2, C9, J9, and so on) against the PR #36 roadmap.
- No owner is assigned for implementation. No source custody is claimed.
