---
date: 2026-11-08
type: concept
tags: [se1, evidence, scans, provenance, explainability]
sources: [lib/shared/se1-catalog.ts, lib/shared/se1-dossier.ts, lib/shared/ai-features.ts, app/scans/page.tsx, app/scans/[id]/page.tsx, app/scans/gaps/page.tsx, app/scans/graph/page.tsx, app/llms.txt/route.ts, components/evidence/, docs/nwf-ai-native-10x-plan-2026-10-31.md (homebase)]
---

# se1 evidence surfaces

## The pattern

Every finding a user sees carries three things next to it: an **evidence level** (E0 to E4), a **provenance** line (source, feed, as-of date, scan version), and any **gaps or contradictions** that touch it. The UI never shows a bare flag. A missing provenance field fails closed: the footer says "Unsourced" and names the missing field, rather than printing a partial source line.

Features are built as recipes over scan cards, not as new prompts. The shared registry (`lib/shared/ai-features.ts`) lists each feature with its earliest se1 phase, surface, and cost class (C0 no model call, C1 one small-model narration, C2 council). Every feature added so far is C0.

## Where it appears

- `/scans`: encyclopedia browser with family, role, and evidence-level filters.
- `/scans/[id]`: one card, showing question, prose, caveats, related scans, and the evidence badge.
- `/scans/gaps`: families blocked on an unbuilt feed, with card counts and a coverage total.
- `/scans/graph`: which scans work together and which disagree.
- `/llms.txt`: static description of the above. It says there is no public API or MCP endpoint.
- `lib/shared/se1-dossier.ts`: pure functions for dossier diff, markdown export, contradiction detection, alert quiet hours and caps, Hold/Fold confidence, narration faithfulness, near-duplicate detection, and coverage.

## Contradictions / tensions

> ⚠️ Contradiction: the catalog holds 4 cards, but `ai-features.ts` lists 20 features as if they exist. Feature entries describe the planned surface, and only the scan pages and the logic functions are built. Unresolved; the registry should carry a status field that says which features are live.

> ⚠️ Contradiction: the llms.txt and scan pages say "spec, E0, never run", while the plan's success measures assume E1+ scans. Nothing here changes that, but any screen that shows a level above E0 needs real harness output behind it first. Unresolved until the se1 results store (decision D1) exists.

> ❓ Open question: the faithfulness check (J2) and contradiction detector (D6) are deterministic and tested on synthetic rows only. Their behavior on real dossiers is unverified.

> ❓ Open question: the mobile copy of `lib/shared/se1-*.ts` and `ai-features.ts` is not yet in `scripts/check-shared-drift.mjs`, so drift between web and mobile is not gated for these files.

## See also

- [[decision-se1-pure-logic-before-results-store]] — why these features ship before the results store exists
- [[concept-mobile-web-parity]] — parity headline, not recomputed in this PR (see the PR body)
- [[START-HERE]] · [[index]]

**PR #375 (2026-11-14), scoped assessment.** Adds the 80-row capability ledger (`lib/shared/se1-ledger.ts`) and fixture-backed pure logic for the unstarted rows in `lib/shared/se1/`. Wires four rows on web: A3 citations on `/scans/[id]`, A2 "ask which scan" on `/scans`, and B2 + G3 at `/scans/dossier/[ticker]`, which reads stored Alpaca SIP daily bars. All four are labelled E0 and are not measured. No mobile file, shared-drift pair, or parity-matrix row changed, so the historical headline is not recomputed. Mobile impact: none. The mobile client has none of these surfaces.
