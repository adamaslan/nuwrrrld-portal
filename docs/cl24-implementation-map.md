# cl24 implementation map: build status and feed gaps

**Status: planning record, not evidence of behavior.** Author: Claude (Sonnet 5.5). Verifier: pending.

This answers the planner's request to record exact source gaps instead of building scans that only look runnable. It lists every scan and AI proposal in the cl24 catalog snapshot, what each needs, and whether it is built.

**Snapshot and limits**

- Covers S26-001 to S26-182 and X26-01 to X26-56, the catalog as of the 02:58 EST batch. Batches 18 and 19 (S26-183 to S26-200, X26-57 to X26-60) are **not** in this snapshot because the Captain's Log could not be read reliably. Add them from the log.
- The `needs` column is derived from each scan's catalog group tag and wording, not from a code review of the data. Confirm it per slice before building. A scan marked bar-only may still need an input this repo lacks.
- Feed names follow `lib/shared/se1-catalog.ts` (`alpaca_bars`, `alpaca_news`, `corp_actions`, `edgar`, `fred`, `options_short_interest`). Only `alpaca_bars` is a built feed today.
- A documented gap is not built coverage. Nothing here claims a result, an edge, or a supported scan.

## Summary

| Status | Count | Meaning |
|---|---|---|
| built | 21 | Pure logic exists in a PR. Evidence stays E0. |
| bar-only | 36 | Needs only daily bars (and for cross-sectional ones, a membership input). Not built yet. |
| feed | 77 | Needs an external data source this repo does not have (news, filings, calendars, macro, options, short interest). Gap recorded, no code. |
| input | 41 | Needs an input the caller or pipeline must supply (outcome labels, run manifests, holdings, security master). Buildable as pure functions over supplied data. |
| derived | 7 | Composes or reports on other scans or run state. Build after its inputs. |
| **total** | **182** | S26-001 to S26-182 |

## Scans

| ID | Name | Status | Needs / where |
|---|---|---|---|
| S26-001 | Signal fragility scan | bar-only | bars + detector config |
| S26-002 | Remove-one-detector scan | bar-only | bars + detector config |
| S26-003 | Horizon-disagreement scan | bar-only | bars |
| S26-004 | Data-vintage revision scan | feed | immutable vendor snapshots (two vintages) |
| S26-005 | Null-result diagnostic scan | derived | run state |
| S26-006 | Session-cutoff contamination scan | feed | input availability timestamps |
| S26-007 | Baseline-survival scan | bar-only | bars + a recipe and baselines |
| S26-008 | Liquidity/cost break-even scan | feed | quotes, spreads, fees |
| S26-009 | Universe-selection sensitivity scan | feed | dated universe membership vintages |
| S26-010 | Contradiction freshness scan | derived | run state and timestamps |
| S26-011 | Shared-input cluster scan | derived | scan metadata |
| S26-012 | Invalidation blast-radius scan | input | dependency graph of dossiers and claims |
| S26-013 | Failed-breakdown reclaim | built | PR #410 |
| S26-014 | Second-low selling-pressure contraction | built | PR #410 |
| S26-015 | Base-width versus depth scan | bar-only | bars |
| S26-016 | Post-capitulation stabilization | built | PR #410 |
| S26-017 | Higher-low with breadth confirmation | feed | bars + point-in-time sector membership |
| S26-018 | Downside follow-through failure | built | PR #410 |
| S26-019 | Relative-strength bottom lead | bar-only | bars + sector ETF mapping |
| S26-020 | Gap-down repair ladder | built | PR #410 |
| S26-021 | Repeated downside rejection with close recovery | built | PR #410 |
| S26-022 | Bottom-pattern disagreement register | built | PR #410 |
| S26-023 | Failed-breakout shelf loss | bar-only | daily bars |
| S26-024 | Successive-high participation decay | bar-only | daily bars |
| S26-025 | Leadership-rank rollover | bar-only | bars for many members + membership or classification input |
| S26-026 | Blow-off extension and range reversal | bar-only | daily bars |
| S26-027 | Resistance rejection cluster | bar-only | daily bars |
| S26-028 | Distribution-range exit | bar-only | daily bars |
| S26-029 | Defensive-sector relative rotation | bar-only | bars for many members + membership or classification input |
| S26-030 | Bearish oscillator-price disagreement age | bar-only | daily bars |
| S26-031 | Rally-repair failure after structure loss | bar-only | daily bars |
| S26-032 | Top-risk evidence conflict register | derived | outputs of other scans |
| S26-033 | Moving-average stack repair order | bar-only | daily bars |
| S26-034 | Crossover survival curve input | bar-only | daily bars |
| S26-035 | Trend-versus-chop path efficiency | built | PR #409 |
| S26-036 | Transition speed after long-average reclaim | bar-only | daily bars |
| S26-037 | Pullback depth consistency | bar-only | daily bars |
| S26-038 | Close-location persistence around trend support | bar-only | daily bars |
| S26-039 | Long-trend slope curvature | bar-only | daily bars |
| S26-040 | Momentum reset without structure break | bar-only | daily bars |
| S26-041 | Price-versus-total-return trend divergence | feed | approved total-return series |
| S26-042 | Horizon-specific transition map | derived | outputs of other scans |
| S26-043 | Dollar-volume floor persistence | built | PR #404 |
| S26-044 | Participation-adjusted breakout contrast | built | PR #407 |
| S26-045 | Volume concentration fragility | built | PR #406 |
| S26-046 | Up/down participation asymmetry with coverage | built | PR #406 |
| S26-047 | Price-impact proxy regime shift | built | PR #408 |
| S26-048 | Quiet-pullback versus abandonment contrast | built | PR #407 |
| S26-049 | Volume-source discontinuity | feed | feed and venue metadata |
| S26-050 | Volume-price confirmation lag | built | PR #407 |
| S26-051 | Candidate capacity screen | built | PR #407 |
| S26-052 | Volume-confirmation dependence map | derived | outputs of other scans |
| S26-053 | Compression-duration percentile | bar-only | daily bars |
| S26-054 | Squeeze-release direction ambiguity | bar-only | daily bars |
| S26-055 | Failed volatility release | bar-only | daily bars |
| S26-056 | Upside/downside semivariance balance | built | PR #409 |
| S26-057 | Gap-versus-session range contribution | built | PR #409 |
| S26-058 | Range expansion without close progress | built | PR #409 |
| S26-059 | Post-shock volatility normalization | bar-only | daily bars |
| S26-060 | Cross-sectional volatility rank stability | bar-only | bars for many members + membership or classification input |
| S26-061 | Low-volatility breakdown distance | built | PR #409 |
| S26-062 | Volatility-estimator disagreement | bar-only | daily bars |
| S26-063 | Breadth thrust versus coverage jump | bar-only | bars for many members + membership or classification input |
| S26-064 | Equal-weight versus capitalization-weight divergence | feed | point-in-time market capitalization |
| S26-065 | New-high/new-low participation balance | built | PR #409 |
| S26-066 | Index strength with narrowing participation | bar-only | bars for many members + membership or classification input |
| S26-067 | Sector-relative rank migration matrix | bar-only | bars for many members + membership or classification input |
| S26-068 | Market-neutral residual persistence | bar-only | bars for many members + membership or classification input |
| S26-069 | Rebound participation asymmetry | bar-only | bars for many members + membership or classification input |
| S26-070 | Leadership concentration by industry cluster | bar-only | bars for many members + membership or classification input |
| S26-071 | Benchmark-choice rank sensitivity | bar-only | bars for many members + membership or classification input |
| S26-072 | Breadth inflection availability ledger | derived | outputs of other scans |
| S26-073 | Event-proximity eligibility | feed | corp_actions (corporate actions and earnings calendar) |
| S26-074 | Earnings-gap hold versus full-session reversal | feed | corp_actions (corporate actions and earnings calendar) |
| S26-075 | Split-adjustment artifact detector | feed | corp_actions (corporate actions and earnings calendar) |
| S26-076 | Dividend versus price-drop attribution | feed | corp_actions (corporate actions and earnings calendar) |
| S26-077 | Event-rescheduling invalidation | feed | corp_actions (corporate actions and earnings calendar) |
| S26-078 | Post-announcement drift with baseline match | feed | corp_actions (corporate actions and earnings calendar) |
| S26-079 | Known-event clustering | feed | corp_actions (corporate actions and earnings calendar) |
| S26-080 | Trading-halt return uncertainty | feed | corp_actions (corporate actions and earnings calendar) |
| S26-081 | Symbol-change continuity | feed | corp_actions (corporate actions and earnings calendar) |
| S26-082 | Event-window exclusion sensitivity | bar-only | daily bars |
| S26-083 | First-seen novelty versus recycled story | feed | alpaca_news (news text) |
| S26-084 | Independent-source corroboration | feed | alpaca_news (news text) |
| S26-085 | Corrected-headline impact | feed | alpaca_news (news text) |
| S26-086 | News-tone versus price-reaction divergence | feed | alpaca_news (news text) |
| S26-087 | Named-entity ambiguity gate | feed | alpaca_news (news text) |
| S26-088 | Numeric-claim support scan | feed | alpaca_news (news text) |
| S26-089 | Rumor-to-confirmed state transition | feed | alpaca_news (news text) |
| S26-090 | Attention spike versus coverage expansion | feed | alpaca_news (news text) |
| S26-091 | Sector catalyst propagation | feed | alpaca_news (news text) |
| S26-092 | Headline-only insufficiency register | feed | alpaca_news (news text) |
| S26-093 | Filing availability versus period age | feed | edgar (SEC filings and fundamentals) |
| S26-094 | Comparable-period continuity | feed | edgar (SEC filings and fundamentals) |
| S26-095 | Standalone-quarter versus cumulative cash flow | feed | edgar (SEC filings and fundamentals) |
| S26-096 | Cash-conversion sign boundary | feed | edgar (SEC filings and fundamentals) |
| S26-097 | Working-capital contribution decomposition | feed | edgar (SEC filings and fundamentals) |
| S26-098 | Revenue-versus-receivables divergence | feed | edgar (SEC filings and fundamentals) |
| S26-099 | Accrual ratio denominator sensitivity | feed | edgar (SEC filings and fundamentals) |
| S26-100 | Free-cash-flow definition bridge | feed | edgar (SEC filings and fundamentals) |
| S26-101 | Acquisition/disposal comparability break | feed | edgar (SEC filings and fundamentals) |
| S26-102 | Share-count denominator consistency | feed | edgar (SEC filings and fundamentals) |
| S26-103 | Multiple eligibility and sign transitions | feed | edgar (SEC filings) plus bars |
| S26-104 | Enterprise-value timestamp mismatch | feed | edgar (SEC filings) plus bars |
| S26-105 | Peer-set fragility | feed | edgar (SEC filings) plus bars |
| S26-106 | Self-history regime break | feed | edgar (SEC filings) plus bars |
| S26-107 | Debt-maturity coverage ladder | feed | edgar (SEC filings and fundamentals) |
| S26-108 | Restricted-cash liquidity distinction | feed | edgar (SEC filings and fundamentals) |
| S26-109 | Interest-coverage denominator quality | feed | edgar (SEC filings and fundamentals) |
| S26-110 | Floating-rate exposure and hedging gap | feed | edgar (SEC filings and fundamentals) |
| S26-111 | Covenant headroom evidence | feed | edgar (SEC filings and fundamentals) |
| S26-112 | Lease-inclusive leverage sensitivity | feed | edgar (SEC filings and fundamentals) |
| S26-113 | Insider transaction-code eligibility | feed | edgar (insider and holder filings) |
| S26-114 | Insider economic-event deduplication | feed | edgar (insider and holder filings) |
| S26-115 | Cluster breadth versus one actor | feed | edgar (insider and holder filings) |
| S26-116 | Trading-plan disclosure uncertainty | feed | edgar (insider and holder filings) |
| S26-117 | Insider purchase scale with denominator coverage | feed | edgar (insider and holder filings) |
| S26-118 | Ownership amendment materiality | feed | edgar (insider and holder filings) |
| S26-119 | Passive/active filing-category transition | feed | edgar (insider and holder filings) |
| S26-120 | Manager concentration versus price drift | feed | edgar (insider and holder filings) |
| S26-121 | Apparent institutional exit uncertainty | feed | edgar (insider and holder filings) |
| S26-122 | Delayed-holder agreement without false independence | feed | edgar (insider and holder filings) |
| S26-123 | First-release versus revised macro state | feed | fred (macro series, with vintages) |
| S26-124 | Policy target versus effective rate distinction | feed | fred (rate series) |
| S26-125 | Curve shape change decomposition | feed | fred (rate series) |
| S26-126 | Nominal versus real-rate definition gate | feed | fred (rate series) |
| S26-127 | Release-window market alignment | feed | fred (macro series, with vintages) |
| S26-128 | Consensus-surprise provenance | feed | fred (macro series, with vintages) |
| S26-129 | Currency translation versus local return | feed | fred or ETF series |
| S26-130 | Commodity spot versus futures-roll distinction | feed | fred or ETF series |
| S26-131 | Credit-spread versus yield-level decomposition | feed | fred (credit series) |
| S26-132 | Regime persistence without threshold chatter | feed | fred (macro series, with vintages) |
| S26-133 | Same-issuer security overlap | input | user holdings and supported valuations |
| S26-134 | Fund look-through coverage | input | user holdings and supported valuations |
| S26-135 | Concentration change from drift versus flows | input | user holdings and supported valuations |
| S26-136 | Correlation sample-overlap gate | input | user holdings and supported valuations |
| S26-137 | Downside co-movement versus full-sample correlation | input | user holdings and supported valuations |
| S26-138 | Factor exposure residual coverage | input | user holdings and supported valuations |
| S26-139 | Liquidity concentration under participation assumptions | input | user holdings and supported valuations |
| S26-140 | Historical stress-window completeness | input | user holdings and supported valuations |
| S26-141 | Scenario shock consistency | input | user holdings and supported valuations |
| S26-142 | Scan-evidence dependency concentration | input | user holdings and supported valuations |
| S26-143 | Short-interest observation versus publication age | feed | options_short_interest (short interest and borrow) |
| S26-144 | Days-to-cover denominator stability | feed | options_short_interest (short interest and borrow) |
| S26-145 | Short-interest versus short-volume distinction | feed | options_short_interest (short interest and borrow) |
| S26-146 | Borrow-cost observation coverage | feed | options_short_interest (short interest and borrow) |
| S26-147 | Options activity versus open-interest change | feed | options_short_interest (options chain) |
| S26-148 | Options-chain comparability gate | feed | options_short_interest (options chain) |
| S26-149 | Implied-volatility quote-quality gate | feed | options_short_interest (options chain) |
| S26-150 | Term-structure constant-horizon sensitivity | feed | options_short_interest (options chain) |
| S26-151 | Distribution-type and frequency normalization | feed | corp_actions (distributions) |
| S26-152 | Declared payout versus cash-flow coverage | feed | corp_actions (distributions) |
| S26-153 | Forward-label maturity register | input | supplied outcome labels and splits |
| S26-154 | Overlapping-event dependence register | input | supplied outcome labels and splits |
| S26-155 | Purged temporal holdout leakage check | input | supplied outcome labels and splits |
| S26-156 | Universe survival and eligibility audit | input | supplied outcome labels and splits |
| S26-157 | Signal return versus unconditional baseline | input | supplied outcome labels and splits |
| S26-158 | Cost and fill-assumption sensitivity | input | supplied outcome labels and splits |
| S26-159 | Multiple-testing and selection-history record | input | supplied outcome labels and splits |
| S26-160 | Regime/sector robustness concentration | input | supplied outcome labels and splits |
| S26-161 | Abstention-versus-error coverage frontier | input | supplied outcome labels and splits |
| S26-162 | Reproducible result manifest | input | supplied outcome labels and splits |
| S26-163 | Run-denominator reconciliation | input | run manifests and pipeline records |
| S26-164 | Partial-versus-final bar contamination | input | run manifests and pipeline records |
| S26-165 | Freshness distribution versus newest record | input | run manifests and pipeline records |
| S26-166 | Cross-worker duplicate/conflict scan | input | run manifests and pipeline records |
| S26-167 | Provider schema/unit drift | input | run manifests and pipeline records |
| S26-168 | Retry outcome masking | input | run manifests and pipeline records |
| S26-169 | Cutoff-consistent multi-source join | input | run manifests and pipeline records |
| S26-170 | Cache versus origin provenance drift | input | run manifests and pipeline records |
| S26-171 | Cancellation/resume completeness | input | run manifests and pipeline records |
| S26-172 | Source retirement and entitlement gap | input | run manifests and pipeline records |
| S26-173 | Asset-to-detector compatibility matrix | input | security master, membership and calendar data |
| S26-174 | Symbol reuse and issuer discontinuity | input | security master, membership and calendar data |
| S26-175 | Listing-transfer and exchange-calendar continuity | input | security master, membership and calendar data |
| S26-176 | Depositary-receipt ratio and currency alignment | input | security master, membership and calendar data |
| S26-177 | Leveraged/inverse fund horizon mismatch | input | security master, membership and calendar data |
| S26-178 | Fund inception and benchmark backfill boundary | input | security master, membership and calendar data |
| S26-179 | Continuous-market versus exchange-session aggregation | input | security master, membership and calendar data |
| S26-180 | Halted/suspended versus no-trade versus feed-gap state | input | security master, membership and calendar data |
| S26-181 | Corporate-action lifecycle completion | input | security master, membership and calendar data |
| S26-182 | Registry expansion comparability bridge | input | security master, membership and calendar data |

## AI proposals (X26)

Only X26-04 is built (PR #405, behind the `scan_ai_assist` flag, off). The rest depend on Instinct's compact-evidence packet or on a scan above that is not built. None is built here.

| ID | Name | Status |
|---|---|---|
| X26-01 | Evidence-budget planner | not built |
| X26-02 | Stability-aware idea ranking | not built |
| X26-03 | Dependence-aware Council packet | not built |
| X26-04 | Honest neutral explainer | built (PR #405, flag off) |
| X26-05 | Corrected-data briefing | not built |
| X26-06 | Cutoff-safe answer compiler | not built |
| X26-07 | Evidence disagreement referee | not built |
| X26-08 | Horizon negotiation assistant | not built |
| X26-09 | Cost-aware paper idea explainer | not built |
| X26-10 | Coverage-sensitive portfolio critique | not built |
| X26-11 | Survivorship challenge card | not built |
| X26-12 | Evidence correction inbox | not built |
| X26-13 | Scan-to-question coverage map | not built |
| X26-14 | Abstention-quality evaluator | not built |
| X26-15 | Same-evidence model comparison | not built |
| X26-16 | Claim-level counterexample finder | not built |
| X26-17 | Repair-or-stop tool coach | not built |
| X26-18 | Recipe-change impact preview | not built |
| X26-19 | Novelty-with-evidence idea composer | not built |
| X26-20 | Insight acceptance scoreboard | not built |
| X26-21 | Bottom-hypothesis workbench | not built |
| X26-22 | Confirmation-delay tutor | not built |
| X26-23 | Top-versus-healthy-consolidation referee | not built |
| X26-24 | Bearish-language scope checker | not built |
| X26-25 | Trend-transition timeline explainer | not built |
| X26-26 | Whipsaw counterexample selector | not built |
| X26-27 | Compact participation explainer | not built |
| X26-28 | Sparse narration priority selector | not built |
| X26-29 | Volatility-state labeler | not built |
| X26-30 | Unit-and-estimator explanation check | not built |
| X26-31 | Breadth denominator translator | not built |
| X26-32 | Benchmark-choice explanation capsule | not built |
| X26-33 | Event-timing evidence capsule | not built |
| X26-34 | Corporate-action false-signal explainer | not built |
| X26-35 | Three-excerpt catalyst classifier | not built |
| X26-36 | Claim-versus-reaction separator | not built |
| X26-37 | Accounting-comparability capsule | not built |
| X26-38 | Earnings-quality qualifier check | not built |
| X26-39 | Valuation-comparison qualifier | not built |
| X26-40 | Liquidity-claim evidence map | not built |
| X26-41 | Transaction-footnote ambiguity capsule | not built |
| X26-42 | Ownership-change narrative verifier | not built |
| X26-43 | Disclosure-age question router | not built |
| X26-44 | Macro-vintage explanation capsule | not built |
| X26-45 | Cross-asset comparison question check | not built |
| X26-46 | Portfolio-evidence coverage capsule | not built |
| X26-47 | Stress-language verifier | not built |
| X26-48 | Market-position claim checker | not built |
| X26-49 | Distribution/volatility caveat selector | not built |
| X26-50 | Evaluation-claim verifier | not built |
| X26-51 | Abstention-case diagnosis | not built |
| X26-52 | Version-to-version evidence delta | not built |
| X26-53 | Run-failure capsule | not built |
| X26-54 | Provenance-disagreement explainer | not built |
| X26-55 | Asset-eligibility explanation | not built |
| X26-56 | Security-lineage claim verifier | not built |

## Where the built scans live

- PR #404: S26-043. PR #406: S26-045, S26-046. PR #407: S26-044, S26-048, S26-050, S26-051. PR #408: S26-047.
- This PR carries PR #409 (S26-035, 056, 057, 058, 061, 065) and PR #410 (S26-013, 014, 016, 018, 020, 021, 022) with the independent review's fixes.

## Open items

- Add batches 18 and 19 from the log.
- Confirm each `needs` entry against the repo's actual inputs before building that slice.
- Parameters in built scans (event multiples, split band, windows) are provisional and configurable, per the planner. They are not calibrated thresholds.
