/**
 * se1-ledger — the 80 target capabilities that are not live yet (audit of 2026-11-13,
 * homebase docs/nwf-100-verification-and-robustness-2026-11-13.md).
 *
 * 100 targets = 10 baseline (L01–L10) + 90 additions (A1–J9). Ten additions are live on
 * the web portal (LIVE_WEB_IDS). The other 80 are the rows below.
 *
 * Each row's fixture-backed logic lives in one module per track (lib/shared/se1/<track>.ts),
 * and its acceptance case is asserted in __tests__/se1/<track>.test.ts inside a
 * `describe("<ID>: …")` block. __tests__/se1-ledger.test.ts treats a row as having its
 * logic-level acceptance test exactly when that describe block exists.
 *
 * `web: "logic_only"` means the shared logic exists here for a web caller to use; no route
 * or component calls it yet. `mobile` stays "planned" until the file is copied into
 * gcp3-mobile and added to scripts/check-shared-drift.mjs. "integrated" or higher must be
 * backed by a caller in app/ or components/.
 *
 * Pure data, no I/O, no web-only imports, so it can be copied byte-identical to gcp3-mobile.
 */
import type { CostClass, Surface } from "./ai-features";
import type { Phase } from "./se1-catalog";

/** Delivery stage from the 100-feature roadmap (S0 is the baseline and has no row here). */
export type Stage = "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7";

/** Software-delivery state per surface. Separate from a scan's runtime evidence level E0–E4. */
export type DeliveryState = "planned" | "logic_only" | "integrated" | "verified" | "released";

/** Where the row stood on origin/main at the audit. */
export type LedgerGroup = "logic_no_caller" | "in_open_pr" | "not_started";

/**
 * Lowest model tier that may build the fixture-backed logic slice.
 * small: a deterministic function with an obvious fail-closed rule.
 * intermediate: statistics, time zones, point-in-time data or idempotency.
 * large: privacy, tenant isolation, secrets or request-forgery defences.
 */
export type Lane = "small" | "intermediate" | "large";

/** What still stands between the logic slice and a live feature. */
export type Blocker =
  | "caller_wiring"        // logic exists or can exist; no route or component calls it
  | "results_store"        // needs real scan rows (owner decision D1)
  | "model_call"           // needs narration behind the J2 gate, with a budget
  | "eval_harness"         // needs E3 evidence, which no card has
  | "news_feed"
  | "earnings_feed"
  | "fundamentals_feed"
  | "ownership_macro_feed"
  | "mobile_native"        // needs a device build in gcp3-mobile
  | "push_consent"         // needs notification consent and delivery
  | "auth_entitlement"     // touches auth, entitlements or private data
  | "owner_decision";      // needs Adam's explicit approval before integration

export interface LedgerRow {
  /** Plan ID, e.g. B2. */
  id: string;
  title: string;
  track: string;
  stage: Stage;
  se1: Phase;
  surface: Surface;
  cost: CostClass;
  group: LedgerGroup;
  /** "n/a" when the plan does not target that surface. */
  web: DeliveryState | "n/a";
  mobile: DeliveryState | "n/a";
  lane: Lane;
  blockers: readonly Blocker[];
  /** Other plan IDs whose logic this row calls. */
  needs: readonly string[];
  /** The pure function(s) to build first, over fixtures. No I/O, no model call. */
  slice: string;
  /** The roadmap's feature-specific acceptance case (Q11). */
  acceptance: string;
  /** Override for rows built before the one-file-per-ID convention. */
  module?: string;
  /** Override: the test file that asserts this row's Q11 at the logic level. */
  test?: string;
  /** Open PR carrying the logic, when group is in_open_pr. */
  pr?: number;
}

/** The ten additions live on the web portal. They are outside this ledger. */
export const LIVE_WEB_IDS: readonly string[] = ["A7", "A9", "G1", "G2", "G5", "G6", "G7", "G9", "I1", "J9"];

const DOSSIER = "lib/shared/se1-dossier.ts";
const FIXES_TEST = "__tests__/se1-defect-fixes-20261114.test.ts";

export const LEDGER: readonly LedgerRow[] = [
  // ── A. Ask ────────────────────────────────────────────────────────────────
  { id: "A1", title: "\"Why is X moving?\" from explain scans + news", track: "Ask", stage: "S6", se1: "P2", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["news_feed", "model_call"], needs: [],
    slice: "newsBeforeCutoff(items, cutoff): keep items whose published_at parses and is <= cutoff; return the rest with a reason (after_cutoff | no_timestamp).",
    acceptance: "News published after the cutoff is excluded; price movement is not presented as proven causation." },
  { id: "A2", title: "Ask-a-scan: plain-language question to a scan", track: "Ask", stage: "S3", se1: "P0", surface: "both", cost: "C1",
    group: "not_started", web: "integrated", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "matchScanQuestion(question, cards): return {match} only when one card clearly leads, {clarify, candidates} on a tie, {none} otherwise; validateScanParams rejects unknown parameters.",
    acceptance: "Ambiguous scan matches ask for clarification; unsupported parameters never trigger execution." },
  { id: "A3", title: "Scan-ID citations that open the card", track: "Ask", stage: "S1", se1: "P0", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "integrated", mobile: "planned", lane: "small", blockers: ["caller_wiring"], needs: [],
    slice: "resolveCitations(text, knownIds): a well-formed ID that is not a known card becomes {type: 'unknown_scan'}, never a link (audit R10).",
    acceptance: "A rendered finding opens the correct versioned scan card; unknown citations fail visibly." },
  { id: "A4", title: "\"What would change your mind?\" from contradicts edges", track: "Ask", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "counterEvidence(dossier, cards): rows whose card is linked by `contradicts` to a flagged row; none found returns {gap: reason}.",
    acceptance: "No contradicting evidence yields an explicit gap, never an invented counterargument." },
  { id: "A5", title: "Compare two tickers on the same recipe", track: "Ask", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "compareOnRecipe(a, b): pair rows by scan_id; refuse when as_of differs; list every scan present on one side only as not comparable.",
    acceptance: "Different dates or missing inputs prevent an apparently like-for-like comparison." },
  { id: "A6", title: "Screen in words", track: "Ask", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "compileScreen(filters): check each {field, op, value} against an allowlist of fields, operators and ranges; any unsupported filter returns errors and no query.",
    acceptance: "Natural-language filters compile to validated fields; unsupported filters are rejected before running." },
  { id: "A8", title: "Chat memory of followed tickers and holdings", track: "Ask", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "large", blockers: ["auth_entitlement", "results_store"], needs: [],
    slice: "contextCacheKey(userId, scope) and clearUserContext(store, userId): every key carries the user id; a missing user id is an error; logout removes all of that user's keys.",
    acceptance: "Switching users or logging out clears private context and prevents cache reuse across users." },

  // ── B. Deep dives and dossiers ────────────────────────────────────────────
  { id: "B1", title: "One-tap Deep Dive page (full recipe)", track: "Dossiers", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "deepDiveSections(dossier, recipe): each section is complete | partial | unavailable with reasons; overall coverage is 'full' only when every section is complete.",
    acceptance: "A mixed complete/partial dossier labels each unavailable section and never claims full coverage." },
  { id: "B2", title: "Momentum-entry dossier", track: "Dossiers", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "integrated", mobile: "planned", lane: "intermediate", blockers: ["results_store"], needs: [],
    slice: "momentumEntryDossier(bars, minBars): fewer than minBars returns missing with a reason; the same bars always return the same rows. Read PR #361 (MA-distance research) first.",
    acceptance: "Short history yields missing, while fixed valid input reproduces the same momentum findings." },
  { id: "B3", title: "Pre-earnings dossier", track: "Dossiers", stage: "S6", se1: "P2", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["earnings_feed", "model_call"], needs: [],
    slice: "preEarningsValidity(dossier, event): the dossier records the event date it was built for; a moved or cancelled event returns invalidated with the reason.",
    acceptance: "A changed or canceled earnings date invalidates the previous dossier timing." },
  { id: "B4", title: "Dip-check dossier", track: "Dossiers", stage: "S7", se1: "P3", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["fundamentals_feed", "model_call"], needs: [],
    slice: "dipCheckVerdict(priceRows, fundamentals): null or incomplete fundamentals return 'inconclusive: fundamentals unavailable', whatever the price rows say.",
    acceptance: "Missing fundamentals prevent a buy-opportunity conclusion despite positive price signals." },
  { id: "B5", title: "Thesis-break dossier for a holding", track: "Dossiers", stage: "S7", se1: "P3", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["fundamentals_feed", "results_store", "model_call"], needs: ["B7"],
    slice: "thesisBreak(frozenSnapshot, current): compare against a snapshot carrying an id and content hash; a missing id or a hash mismatch is an error, not a comparison.",
    acceptance: "Compare a holding thesis to a frozen prior snapshot, never to silently replaced history." },
  { id: "B6", title: "Quality-value dossier", track: "Dossiers", stage: "S7", se1: "P3", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["fundamentals_feed", "model_call"], needs: [],
    slice: "safeRatio(numerator, denominator): a null, zero, negative or non-finite denominator returns {unavailable, reason}; the score covers available ratios only and states how many.",
    acceptance: "Unavailable or incompatible valuation denominators are labeled rather than divided into a score." },
  { id: "B7", title: "Dossier diff: what changed since last week", track: "Dossiers", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    module: DOSSIER, test: FIXES_TEST,
    slice: "diffDossiers (built; R2 fixed in #374). Remaining work is a renderer and a caller.",
    acceptance: "A version/input change is distinguished from a market change in the rendered diff." },
  { id: "B8", title: "Shareable dossier link (OG image)", track: "Dossiers", stage: "S2", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision", "results_store"], needs: [],
    slice: "publicDossierView(dossier, link): returns an allowlist of public fields only; a revoked or unknown link returns nothing. Read PR #369 (verdict pages) first.",
    acceptance: "Anonymous and revoked-link requests cannot expose holdings; OG previews use approved public fields." },
  { id: "B9", title: "Dossier export (PDF / markdown)", track: "Dossiers", stage: "S2", se1: "P1", surface: "web", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["caller_wiring", "owner_decision"], needs: [],
    module: DOSSIER, test: FIXES_TEST,
    slice: "dossierToMarkdown (built; R3 fixed in #374). PDF does not exist: build it or record the scope change with an owner and date.",
    acceptance: "Markdown and PDF preserve missing/evidence/provenance fields and safely escape untrusted content." },

  // ── C. Council ────────────────────────────────────────────────────────────
  { id: "C1", title: "Each seat gets a role-sliced dossier", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C2",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: [],
    slice: "sliceForSeat(dossier, seatRoles, cards): rows whose card role is in the seat's declared roles; an empty slice returns {abstain, reason}.",
    acceptance: "Each seat receives only its declared role slice; a missing slice produces an explicit abstention." },
  { id: "C2", title: "Contradictions become the council's debate agenda", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C2",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: ["D6"],
    slice: "debateAgenda(report): one agenda item per qualified pair from detectContradictions; no pairs returns an empty agenda with the reason.",
    acceptance: "An agenda references actual conflicting rows; absent conflicts never create synthetic debate." },
  { id: "C3", title: "Seat claims are checked against scan rows", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["results_store", "model_call"], needs: ["J2"],
    slice: "checkSeatClaim(text, rows, attempt, maxAttempts): runs checkFaithfulness; any ungrounded or unverifiable sentence rejects; past maxAttempts returns abstain.",
    acceptance: "A fabricated number or incorrect unit is rejected even if the sentence contains a valid scan ID." },
  { id: "C4", title: "Council missing-evidence section", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    module: DOSSIER, test: "__tests__/se1-dossier.test.ts",
    slice: "missingEvidenceSection (built; R4 fixed in #374). Remaining work is to keep the section through council summarization.",
    acceptance: "Missing evidence survives rendering and summarization, including an entirely empty dossier." },
  { id: "C5", title: "Devil's-advocate seat that must use contradicts scans", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C2",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: ["A4"],
    slice: "advocateInputs(dossier, cards): the contrary rows the seat may cite; none returns {abstain, reason}.",
    acceptance: "The advocate abstains when no applicable contrary evidence exists; it must not manufacture it." },
  { id: "C6", title: "Council replay: rerun a past verdict on today's rows", track: "Council", stage: "S4", se1: "P1", surface: "web", cost: "C2",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["results_store", "model_call"], needs: [],
    slice: "replayRecord(original, rerun): returns the original unchanged, the rerun labelled with its date, and the lists of changed row and model identities.",
    acceptance: "Replay preserves the original verdict, shows changed data/model identities and labels today's rerun." },
  { id: "C7", title: "Verdict scorecard: council calls vs later outcomes", track: "Council", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["eval_harness", "results_store"], needs: ["J1"],
    slice: "verdictScorecard(calls, outcomes, asOf): outcomes not yet matured count as pending; returns hits, the denominator and the baseline. Read PR #368 (public track record) first.",
    acceptance: "Unmatured outcomes stay pending; cohort denominator and baseline are visible with the scorecard." },
  { id: "C8", title: "Sector council (sector_rotation)", track: "Council", stage: "S7", se1: "P4", surface: "web", cost: "C2",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["ownership_macro_feed", "model_call"], needs: [],
    slice: "sectorInputsGate(required, available): returns the claims each missing or stale input blocks; a partial recipe is never reported as complete.",
    acceptance: "Unavailable macro/sector inputs block affected claims rather than silently using a partial recipe." },
  { id: "C9", title: "Quick-ask returns the top 3 scans behind the answer", track: "Council", stage: "S3", se1: "P1", surface: "both", cost: "C0",
    group: "in_open_pr", web: "planned", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [], pr: 352,
    slice: "topScansBehindAnswer, in PR #352 (lib/shared/se1-roadmap2.ts). Probe it against the acceptance case before merge.",
    acceptance: "Fewer than three supported findings remain fewer than three; no filler citations are invented." },

  // ── D. Proactive monitoring ───────────────────────────────────────────────
  { id: "D1", title: "Nightly \"new flags on your tickers\" digest", track: "Monitoring", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call", "push_consent"], needs: ["D9"],
    slice: "digestSendDecision(userId, runId, alreadySent): the key is user id + run id; a key already in alreadySent returns {send: false, reason: 'duplicate_run'}.",
    acceptance: "Retrying the same digest run does not send duplicate notifications to a user." },
  { id: "D2", title: "Threshold push: a followed ticker crosses a scan flag", track: "Monitoring", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["results_store", "push_consent", "mobile_native", "owner_decision"], needs: ["D9"],
    slice: "flagCrossings(history): one crossing per false-to-true transition; consecutive true rows produce none. Read PR #370 (holdings signal-change detector) first.",
    acceptance: "Repeated flag rows produce one threshold-crossing notification, not one per poll." },
  { id: "D3", title: "Thesis-break alert on a holding", track: "Monitoring", stage: "S7", se1: "P3", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["fundamentals_feed", "results_store", "model_call", "push_consent"], needs: ["B5", "D9"],
    slice: "filterQueuedAlerts(queue, currentHoldings): drops every queued alert whose ticker is no longer held and returns the dropped ones with the reason.",
    acceptance: "A holdings change invalidates queued alerts for positions the user no longer owns." },
  { id: "D4", title: "Regime-change banner", track: "Monitoring", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "in_open_pr", web: "planned", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [], pr: 352,
    slice: "regimeBanner, in PR #352 (lib/shared/se1-roadmap2.ts). Probe it against the acceptance case before merge.",
    acceptance: "A stale or noisy regime input produces unavailable/debounced state, not repeated banner flips." },
  { id: "D5", title: "Pre-earnings reminder with the dossier attached", track: "Monitoring", stage: "S6", se1: "P2", surface: "mobile", cost: "C1",
    group: "not_started", web: "n/a", mobile: "planned", lane: "intermediate", blockers: ["earnings_feed", "push_consent", "mobile_native", "model_call"], needs: ["B3"],
    slice: "reconcileReminders(existing, events, consent): a moved event removes the old reminder and keeps exactly one for the new date; cancelled or no consent keeps none.",
    acceptance: "Rescheduled earnings remove the old reminder and retain one consented replacement." },
  { id: "D6", title: "Contradiction alert: two E3+ scans disagree on a holding", track: "Monitoring", stage: "S4", se1: "P1", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["eval_harness", "results_store", "caller_wiring"], needs: [],
    module: DOSSIER, test: FIXES_TEST,
    slice: "detectContradictions (built; R5 fixed in #374). No card is E3 yet, so nothing can qualify until the harness exists.",
    acceptance: "One stale or invalidated E3 record prevents a qualifying E3 contradiction alert." },
  { id: "D7", title: "Weekly \"evidence moved\" note", track: "Monitoring", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["eval_harness"], needs: ["J1"],
    slice: "evidenceMoves(prevCards, currCards): lists promotions, demotions and retirements; demotions and retirements are labelled 'correction' and come first.",
    acceptance: "Invalidation/demotion is surfaced as a correction, not hidden behind promotion-only messaging." },
  { id: "D8", title: "Morning brief rebuilt on se1 rows", track: "Monitoring", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: ["J2"],
    slice: "briefFreshness(lastBuiltAt, now, lastRunFailed): returns the label and the real timestamp; a failed run returns 'stale, last built <timestamp>', never 'today'.",
    acceptance: "A failed morning run shows its actual freshness and does not relabel yesterday's brief as new." },
  { id: "D9", title: "Quiet hours and per-ticker alert budgets", track: "Monitoring", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    module: DOSSIER, test: FIXES_TEST,
    slice: "decideAlert and localHourFor (built; R6 fixed in #374). The cap still needs one conditional write per ticker per local day at integration.",
    acceptance: "Reject invalid hours; test timezone/DST boundaries, atomic caps and retries across devices." },

  // ── E. Portfolio intelligence ─────────────────────────────────────────────
  { id: "E1", title: "Portfolio-wide risk scan", track: "Portfolio", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "in_open_pr", web: "planned", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring", "auth_entitlement"], needs: [], pr: 352,
    slice: "portfolioRisk, in PR #352 (lib/shared/se1-roadmap2.ts). Probe it against the acceptance case before merge.",
    acceptance: "Incomplete holdings coverage is displayed; missing assets never count as zero risk." },
  { id: "E2", title: "Concentration and correlation explainer", track: "Portfolio", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["results_store", "model_call", "auth_entitlement"], needs: [],
    slice: "alignedCorrelation(a, b, minOverlap): align two dated series on shared dates; fewer than minOverlap shared points returns insufficient_data, never 0.",
    acceptance: "Unaligned histories and too few overlapping observations return insufficient data, not zero correlation." },
  { id: "E3", title: "\"Weakest link\" holding ranked by trend + risk", track: "Portfolio", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "in_open_pr", web: "planned", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring", "auth_entitlement"], needs: [], pr: 352,
    slice: "weakestLinks, in PR #352 (lib/shared/se1-roadmap2.ts). Probe it against the acceptance case before merge.",
    acceptance: "Missing trend/risk inputs exclude a holding from ranking and explain the exclusion." },
  { id: "E4", title: "Rebalance candidates as review items, not orders", track: "Portfolio", stage: "S3", se1: "P1", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["results_store", "model_call", "auth_entitlement"], needs: [],
    slice: "rebalanceCandidates(holdings, coverage): every item has status 'needs_review'; the item type has no quantity, side or order field; incomplete coverage is returned with the list.",
    acceptance: "Candidates require review and no code path places an order; incomplete holdings are disclosed." },
  { id: "E5", title: "Health-AI rebuilt on se1 rows", track: "Portfolio", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "large", blockers: ["results_store", "model_call", "auth_entitlement"], needs: ["J2"],
    slice: "healthClaimsGate(text, rows) rejects any claim checkFaithfulness does not ground; healthCacheKey(userId, holdingsHash) always carries the user id.",
    acceptance: "Unsupported health claims are rejected and private holdings never enter another user's cache." },
  { id: "E6", title: "Portfolio regime fit", track: "Portfolio", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "auth_entitlement"], needs: ["D4"],
    slice: "regimeFit(holdingsSnapshot, regime): a null or stale snapshot on either side returns {fit: 'unknown', reason}; there is no default label.",
    acceptance: "Missing regime or holdings snapshots yield unknown fit, not a default positive label." },
  { id: "E7", title: "Earnings-week exposure calendar", track: "Portfolio", stage: "S6", se1: "P2", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["earnings_feed", "auth_entitlement"], needs: [],
    slice: "exposureCalendar(holdings, events, timeZone): event dates are derived in the exchange time zone; a moved event moves its exposure; day totals sum to the week total.",
    acceptance: "Calendar timezone changes and rescheduled events preserve correct exposure dates and totals." },
  { id: "E8", title: "Fundamentals drift across holdings", track: "Portfolio", stage: "S7", se1: "P3", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["fundamentals_feed", "model_call", "auth_entitlement"], needs: [],
    slice: "valueAsOf(filings, date): the value as filed on or before that date; a later amendment is a new vintage and never replaces the original.",
    acceptance: "Amended filings retain the original vintage; drift uses information available at each comparison date." },
  { id: "E9", title: "Ownership/insider changes on holdings", track: "Portfolio", stage: "S7", se1: "P4", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["ownership_macro_feed", "auth_entitlement"], needs: [],
    slice: "ownershipLine(filing): the line carries the filing date, the period end and the lag in days, worded 'as of the filing'; a filing with no date returns unavailable.",
    acceptance: "Report filing availability and lag, never imply disclosure-day ownership is live ownership." },

  // ── F. Hold/Fold and paper trading ────────────────────────────────────────
  { id: "F1", title: "Hold/Fold card shows the 5 scans behind the call", track: "Hold/Fold", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "in_open_pr", web: "planned", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [], pr: 352,
    slice: "holdFoldReasons, in PR #352 (lib/shared/se1-roadmap2.ts). Probe it against the acceptance case before merge.",
    acceptance: "Every displayed reason resolves to a real row; fewer than five supported reasons are allowed." },
  { id: "F2", title: "Hold/Fold confidence as an evidence level", track: "Hold/Fold", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    slice: "holdFoldConfidence returns {level, counts, mixed}: level is the highest level held by at least half the flagged rows; an unknown level is an error (audit R7, still open).",
    acceptance: "Mixed or invalidated evidence cannot inflate the call into calibrated probability or guaranteed confidence." },
  { id: "F3", title: "Paper-trade entries tagged with the recipe", track: "Hold/Fold", stage: "S2", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["results_store", "owner_decision"], needs: [],
    slice: "tagPaperEntry(entry, recipe, inputHash): returns a frozen copy carrying recipe id, version and input hash; changing the recipe object later does not change the tag.",
    acceptance: "A paper entry retains immutable recipe/version/input identity when the recipe later changes." },
  { id: "F4", title: "Paper arbitration reads se1", track: "Hold/Fold", stage: "S3", se1: "P1", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["results_store", "model_call"], needs: [],
    slice: "arbitrationInputs(rows): malformed or absent rows return {abstain, reason}; a test asserts the module imports nothing that can place an order.",
    acceptance: "Malformed/absent rows cause arbitration to abstain; live-order routes remain unreachable." },
  { id: "F5", title: "Post-mortem on closed paper trades", track: "Hold/Fold", stage: "S4", se1: "P1", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["eval_harness", "results_store", "model_call"], needs: ["F3"],
    slice: "postMortemStats(trades): counts wins, losses and unknowns separately, net of costs; a trade with no outcome is 'unknown' and is never a win.",
    acceptance: "Post-mortems include losing trades and costs; missing outcomes are not counted as successes." },
  { id: "F6", title: "\"Fold reasons\" list from risk + cmp Trim gate", track: "Hold/Fold", stage: "S7", se1: "P3", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["fundamentals_feed", "results_store"], needs: [],
    slice: "foldReasons(gateMembers, rows): any gate member with no row returns {incomplete, missing}; reasons are listed only when every member has a row.",
    acceptance: "Missing Trim composite members yield an incomplete gate, not a confident Fold reason." },
  { id: "F7", title: "Paper strategy built from a recipe, backtested", track: "Hold/Fold", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["eval_harness", "results_store"], needs: ["F3"],
    slice: "backtestEntries(rows, costs): entries from the first n rows equal the first entries from the full series; fees and slippage are required arguments with no default.",
    acceptance: "Future rows cannot change prior entries; fees/slippage and untouched evaluation windows are explicit." },
  { id: "F8", title: "Hold/Fold streaks and accuracy per scan family", track: "Hold/Fold", stage: "S4", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["eval_harness", "results_store"], needs: ["J1"],
    slice: "familyAccuracy(outcomes): pending and overlapping outcomes are left out of both hits and the denominator; returns n per family. Read PR #368 first.",
    acceptance: "Pending/overlapping outcomes do not inflate accuracy; sample sizes and denominators reconcile." },
  { id: "F9", title: "Hold/Fold in chat", track: "Hold/Fold", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["results_store", "model_call"], needs: ["F1", "F2"],
    slice: "holdFoldAnswer(ticker, dossier): an unsupported ticker, a null dossier or zero rows returns {abstain, gaps}; a call is returned only with at least one row.",
    acceptance: "Unsupported tickers or missing results produce an abstention with evidence gaps, not a fabricated call." },

  // ── G. Explainability ─────────────────────────────────────────────────────
  { id: "G3", title: "\"How do we know?\" drawer on every finding", track: "Explainability", stage: "S2", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "integrated", mobile: "planned", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    slice: "howWeKnow(row): source, feed, as_of, scan_version and evidence level, each a value or 'unavailable'; the return type has those fields and no others.",
    acceptance: "The drawer reveals exact source/version/cutoff and unavailable fields, without hidden private data." },
  { id: "G4", title: "Hit-rate vs baseline mini-chart on E3+ cards", track: "Explainability", stage: "S4", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "intermediate", blockers: ["eval_harness"], needs: ["J1"],
    slice: "hitRateChartData(hits, n, baseline, minN): n below minN or a missing baseline returns {unavailable, reason}; otherwise the rate, n and an interval.",
    acceptance: "Insufficient samples or missing baseline prevent a persuasive chart; show uncertainty and sample size." },
  { id: "G8", title: "Plain-English glossary generated from cards", track: "Explainability", stage: "S1", se1: "P0", surface: "both", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["model_call"], needs: ["J2"],
    slice: "glossaryEntryCheck(entry, card): reject an entry longer than the cap, or holding a figure or scan ID that is not on the card; the entry key is card id + version.",
    acceptance: "Glossary prose cannot introduce unsupported claims; generation is bounded and versioned with cards." },

  // ── H. Mobile-native ──────────────────────────────────────────────────────
  { id: "H1", title: "Home-screen widget: top flags on followed tickers", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["mobile_native", "results_store", "auth_entitlement"], needs: [],
    slice: "widgetState(snapshot, now, maxAgeMs, locked): returns rows with the last refresh time, or stale or unavailable; locked returns no ticker names.",
    acceptance: "The widget shows last refresh and unavailable/stale state offline, without exposing locked private data." },
  { id: "H2", title: "Voice ask", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C1",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["mobile_native", "model_call"], needs: ["A2", "A6"],
    slice: "voiceRunDecision(candidates, confirmed): more than one candidate returns choices; one candidate runs only when confirmed is true.",
    acceptance: "Ambiguous transcription requires ticker/query confirmation before a costly execution." },
  { id: "H3", title: "Swipe-to-triage the nightly digest", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "intermediate", blockers: ["mobile_native", "results_store"], needs: ["D1"],
    slice: "applyTriage(state, actions): each action has an id and a time; replaying a queue twice, or in another order, gives the same state.",
    acceptance: "Offline triage replay is idempotent and keeps user actions consistent across devices." },
  { id: "H4", title: "Offline dossier cache (last 10)", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "large", blockers: ["mobile_native", "auth_entitlement"], needs: [],
    slice: "cachePut and cacheEvict(cache, now, maxAgeMs): never more than 10 entries, none older than maxAgeMs; clearForUser(cache, userId) leaves nothing of that user.",
    acceptance: "Logout/revocation clears private cached dossiers; the last-ten cap and age are enforced." },
  { id: "H5", title: "Camera/screenshot to ticker to dossier", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C1",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["mobile_native", "model_call"], needs: [],
    slice: "tickerFromExtraction(candidates): zero or several candidates return {confirm, choices}; the result type carries no image data or image path.",
    acceptance: "Ambiguous extracted tickers require confirmation; images are not retained or shared by default." },
  { id: "H6", title: "Lock-screen live activity on earnings day", track: "Mobile", stage: "S6", se1: "P2", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "intermediate", blockers: ["mobile_native", "earnings_feed", "push_consent"], needs: [],
    slice: "liveActivityPlan(deviceSupports, event): an unsupported device returns the fallback; a cancelled event returns stop with a payload holding no private field.",
    acceptance: "Unsupported devices get a fallback; canceled events stop the activity and redact private data." },
  { id: "H7", title: "Haptic flag alerts tiered by evidence level", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["mobile_native", "push_consent"], needs: ["D9"],
    slice: "hapticTier(level, consent, inQuietHours): no consent or quiet hours returns 'none'; the tier never rises when the level falls.",
    acceptance: "No consent or quiet hours suppress haptics; evidence demotion cannot increase urgency." },
  { id: "H8", title: "Share sheet: send a dossier link", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C0",
    group: "not_started", web: "n/a", mobile: "planned", lane: "large", blockers: ["mobile_native", "auth_entitlement"], needs: ["B8"],
    slice: "shareUrl(link): returns a URL only for an active public link; the URL has no query string and no fragment; anything else is an error.",
    acceptance: "Sharing exports an authorized public link, not an authentication token or private cached dossier." },
  { id: "H9", title: "Watch-list onboarding: AI suggests 5 tickers", track: "Mobile", stage: "S5", se1: "P1", surface: "mobile", cost: "C1",
    group: "not_started", web: "n/a", mobile: "planned", lane: "small", blockers: ["mobile_native", "model_call"], needs: [],
    slice: "validateSuggestions(list): at most 5; each needs a rationale and an uncertainty note; text that asserts the user holds a ticker, or a sure outcome, is rejected.",
    acceptance: "Interest-based suggestions show rationale and uncertainty; no inferred holdings or personalized certainty." },

  // ── I. External agents and developer surface ──────────────────────────────
  { id: "I2", title: "Hosted MCP endpoint (se1_*), Pro-gated", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision", "results_store"], needs: [],
    slice: "toolCallGate(caller, tool, args): no caller or no entitlement returns a deny code; args failing the tool schema return an error; over the limit returns rate_limited.",
    acceptance: "Unauthenticated/non-entitled callers cannot invoke tools; limits and schema failures are explicit." },
  { id: "I3", title: "Read-only API keys per user for dossiers", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision"], needs: [],
    slice: "authorizeKey(key, request): a revoked key, a resource owned by another user, or any non-read method returns deny with a code.",
    acceptance: "Revoked or cross-user keys fail; read-only scopes cannot trigger writes or expose other accounts." },
  { id: "I4", title: "\"Use NWF in Claude/ChatGPT\" connector page", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["owner_decision"], needs: ["I2"],
    slice: "connectorPageModel(capabilities): lists only capabilities that are enabled and have an endpoint version; with none enabled it says so.",
    acceptance: "Connector instructions exercise the published endpoint/version; disabled capabilities are not advertised." },
  { id: "I5", title: "Recipe authoring: user saves a custom recipe", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["auth_entitlement", "owner_decision"], needs: [],
    slice: "validateRecipe(recipe, cards, budget): unknown scan IDs, a composition cycle or a cost over budget return errors; the module exports nothing that runs a recipe.",
    acceptance: "Invalid/cyclic/over-budget recipes fail validation; saving one does not execute it." },
  { id: "I6", title: "Shared community recipes (moderated)", track: "External", stage: "S6", se1: "P2", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["auth_entitlement", "owner_decision"], needs: ["I5"],
    slice: "publishState(recipe, moderation): only 'approved' returns published; moderation reads the recipe as text and never calls validateRecipe's scans.",
    acceptance: "Unapproved or malicious recipe text stays unpublished; moderation does not execute submitted content." },
  { id: "I7", title: "Webhook on flag (user-provided URL)", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision", "results_store"], needs: [],
    slice: "webhookTargetAllowed(url, resolvedAddresses): https only; private, loopback and link-local addresses are refused; redirects are not followed; retrySchedule is bounded.",
    acceptance: "Private/loopback targets and redirect/DNS-rebinding escapes are blocked; signing and retries are bounded." },
  { id: "I8", title: "Rate-limited free tier for MCP", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision"], needs: ["I2"],
    slice: "reserveBudget(used, pending, cap, tool, tier): used + pending never exceeds cap; a free-tier caller asking for a paid tool is denied.",
    acceptance: "Concurrent requests cannot exceed the caller budget or obtain paid entitlements through the free tier." },
  { id: "I9", title: "Usage dashboard for API/MCP callers", track: "External", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision"], needs: ["I2", "I3"],
    slice: "usageTotals(events, tenantId): totals equal the count of that tenant's request IDs, retries included; events of other tenants are never read into the result.",
    acceptance: "Usage totals reconcile to request IDs and include retries without exposing another tenant's usage." },

  // ── J. Self-improving operations ──────────────────────────────────────────
  { id: "J1", title: "Evidence harness auto-promotes cards", track: "Operations", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["eval_harness", "results_store", "owner_decision"], needs: [],
    slice: "nextEvidenceState(history, event): a new card version starts at E0; an invalidation demotes; the history is appended to, never rewritten.",
    acceptance: "A new version starts E0; invalidation/demotion propagates and historical evaluations remain available." },
  { id: "J2", title: "Narration faithfulness check", track: "Operations", stage: "S3", se1: "P1", surface: "both", cost: "C1",
    group: "logic_no_caller", web: "logic_only", mobile: "planned", lane: "small", blockers: ["model_call", "caller_wiring"], needs: [],
    module: DOSSIER, test: FIXES_TEST,
    slice: "checkFaithfulness (built; R1 fixed in #374). Every narrated surface must call it and show grounded sentences only.",
    acceptance: "Valid citation plus fabricated value fails; abbreviations, negation, units and multiple claims are tested." },
  { id: "J3", title: "Model-chain A/B on narration quality vs cost", track: "Operations", stage: "S3", se1: "P1", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["model_call", "owner_decision"], needs: ["J2"],
    slice: "abAssignment(key, arms, spent, budget): the same key always gets the same arm; over budget returns the control arm; the record names model, version and fallback.",
    acceptance: "Assignment is stable and budgeted; quality compares equivalent inputs and logs model/version fallbacks." },
  { id: "J4", title: "Drift watch on scan output distribution", track: "Operations", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "intermediate", blockers: ["results_store"], needs: [],
    slice: "driftDecision(prev, curr, minN, inputOutage, alreadyAlerted): n below minN returns insufficient_sample; an outage returns input_outage; a repeat key returns duplicate.",
    acceptance: "Small samples and input outages are separated from real distribution drift with deduplicated alerts." },
  { id: "J5", title: "Near-duplicate scan detector", track: "Operations", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "logic_no_caller", web: "logic_only", mobile: "n/a", lane: "small", blockers: ["results_store", "caller_wiring"], needs: [],
    slice: "nearDuplicates returns {pairs, unassessable: [{a, b, reason}]} with reasons too_short, length_mismatch, flat and non_finite (audit R8, still open).",
    acceptance: "Short, flat or mismatched series return explicit unassessable status; correlation never auto-deletes scans." },
  { id: "J6", title: "Feature-usage telemetry per recipe", track: "Operations", stage: "S4", se1: "P1", surface: "web", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["auth_entitlement", "owner_decision"], needs: [],
    slice: "telemetryEvent(input): the output has recipe id, surface and day only, from an allowlist; pruneProposals(counts) returns a list to review and removes nothing.",
    acceptance: "Telemetry redacts private content; a low count cannot automatically remove a feature or its history." },
  { id: "J7", title: "User feedback on findings feeds harness priorities", track: "Operations", stage: "S4", se1: "P1", surface: "both", cost: "C0",
    group: "not_started", web: "logic_only", mobile: "planned", lane: "small", blockers: ["auth_entitlement", "results_store"], needs: [],
    slice: "applyFeedback(votes, dailyCap): one counted vote per user per finding, at most dailyCap per user per day; the result is a priority number and has no evidence level.",
    acceptance: "Duplicate/abusive feedback is bounded and cannot directly promote evidence levels." },
  { id: "J8", title: "Auto-written incident note when a nightly run degrades", track: "Operations", stage: "S4", se1: "P1", surface: "web", cost: "C1",
    group: "not_started", web: "logic_only", mobile: "n/a", lane: "large", blockers: ["model_call", "owner_decision"], needs: [],
    slice: "checkIncidentNote(note, run): each cause sentence must quote a run ID or log line present in the input, else the note says 'cause unknown'; secret-shaped strings are removed.",
    acceptance: "Incident text cites actual logs/run IDs and never invents causes or publishes secrets." },
];

export function ledgerRow(id: string): LedgerRow | undefined {
  return LEDGER.find((r) => r.id === id);
}

/** Track name → file stem under lib/shared/se1/ and __tests__/se1/. */
export const TRACK_FILE: Readonly<Record<string, string>> = {
  Ask: "ask", Dossiers: "dossiers", Council: "council", Monitoring: "monitoring", Portfolio: "portfolio",
  "Hold/Fold": "holdfold", Explainability: "explain", Mobile: "mobile", External: "external", Operations: "ops",
};

/**
 * Where a row's logic and its acceptance test live. Rows built in se1-dossier.ts before this
 * ledger carry explicit paths; the rest use their track's module and test file.
 * Rows in PR #352 point at the track file but have no describe block there until that PR lands.
 */
export function logicPaths(row: LedgerRow): { module: string; test: string } {
  const stem = TRACK_FILE[row.track];
  return {
    module: row.module ?? `lib/shared/se1/${stem}.ts`,
    test: row.test ?? `__tests__/se1/${stem}.test.ts`,
  };
}

/** Rows a given lane may pick up, in stage order. */
export function rowsForLane(lane: Lane, rows: readonly LedgerRow[] = LEDGER): LedgerRow[] {
  return rows.filter((r) => r.lane === lane).sort((a, b) => a.stage.localeCompare(b.stage) || a.id.localeCompare(b.id));
}
