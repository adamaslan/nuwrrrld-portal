---
date: 2026-11-18
type: concept
tags: [scans, proposals, planning, ai-native, evidence]
sources: [docs/scan-expansion-s26-x26.md, PR#13, PR#36, captain-log-cl24-2026-11-18-0020, captain-log-cl24-2026-11-18-0100]
---

# Concept: Scan Expansion S26 and AI-Native Follow-ons X26

A planning catalog of proposed scans (S26) and bounded AI-native features (X26). Every row is SPEC / E0: nothing is built, run, or measured. The catalog exists so that new ideas arrive with their evidence rules attached, not as renamed copies of existing RSI or moving-average screens.

## The pattern

Each proposal names four things before any code exists:

1. **Parent or refinement.** It points into the existing 200-scan taxonomy and 100-feature roadmap (PR #36) or the scan encyclopedia (PR #13). A proposal that duplicates an existing family is marked as a refinement, not new evidence.
2. **Input and cutoff.** One approved bar snapshot per run. A decision cutoff. A membership version. Missing history is reported as unavailable, never filled with zero or an invented ticker.
3. **Acceptance check.** A fixture-based test that must fail the bad behavior: a fragile score that must be labeled fragile, a future bar that must be rejected, a duplicated signal that must count once.
4. **Evidence level.** Every row is E0 until a held-out evaluation runs against a declared baseline, after costs.

X26 items reuse the same discipline for small models. Each gets a bounded tool or packet, an explicit stop condition, and an abstention or false-confidence measure.

## Where it appears

- `docs/scan-expansion-s26-x26.md`: the full catalog, 22 scans and 22 AI-feature rows so far.
- [[concept-small-model-prompting]]: X26 rows assume the same worst-model-in-chain constraint.
- [[concept-three-state-signal]]: S26-05 and X26-04 separate no-hit, not-computed, and failed, which is the same distinction.
- Captain's Log (homebase#24, cl24): the 2026-11-18 00:20 and 01:00 entries are the source. The log says that no execution, spending, or deployment is authorized.

## Contradictions / tensions

- **Breadth versus evidence.** The log plans 200 scans and 60 AI features, but only 22 and 22 are recorded. Counts are proposal references, not shipped features.
- **Overlap.** Several S26 rows refine existing encyclopedia families (support, RSI divergence, horizon). Exact E80 and PR #36 overlaps still need reconciling before any item is claimed as net-new.
- **Ownership.** The log names no implementation writer. The catalog does not claim source custody.

## See also

- [[concept-mobile-web-parity]]: no direct link, but both pages track "claimed versus measured" coverage.
- [[concept-free-tier-resilience]]: the same free-tier constraints apply to any model call an X26 row would need.
