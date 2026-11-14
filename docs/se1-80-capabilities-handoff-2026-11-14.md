# se1: the 80 capabilities that are not live, and what is left to finish them

Date: 2026-11-14. Branch `feat/se1-ledger-80`, cut from `origin/main` at `3db8925` (#374 merged).
Follows the audit in homebase `docs/nwf-100-verification-and-robustness-2026-11-13.md`.

This is the work list for the next agents, including the small ones (Haiku, Luna). Every step names its lane and
the exact command to run. If a step needs anything outside its lane, stop and ask Adam (see "Rules" at the end).

## 1. What this branch built

100 targets = L01–L10 (baseline) + A1–J9 (90 additions). Ten additions are live on the web portal:
A7, A9, G1, G2, G5, G6, G7, G9, I1 and J9. The other **80** are rows in `lib/shared/se1-ledger.ts`.

| Group | Rows | State after this branch |
|---|---|---|
| Not started at the audit | 66 | Logic written and tested over fixtures, one function (or a small set) per row |
| Logic on main with no caller | 9 | A3, F2 and J5 audit defects fixed (R10, R7, R8). B7, B9, C4, D6, D9 and J2 were already fixed in #374 |
| Logic in open PR #352 | 5 | C9, D4, E1, E3, F1. Untouched here; their ledger slots stay open |

**75 of 80 rows now pass their feature-specific acceptance case (Q11) at the logic level.** That is the only
check that passed. Nothing new is wired into a route or a component, nothing is on mobile, and no live data
reaches any of it. In the roadmap's terms every row is `logic_only` on web and `planned` on mobile.

Where things are:

| Path | What it holds |
|---|---|
| `lib/shared/se1-ledger.ts` | The 80 rows: stage, surface, cost class, lane, blockers, dependencies, acceptance case |
| `lib/shared/se1/<track>.ts` | The logic, one file per track: `ask`, `dossiers`, `council`, `monitoring`, `portfolio`, `holdfold`, `explain`, `mobile`, `external`, `ops`, plus `util` |
| `__tests__/se1/<track>.test.ts` | One `describe("<ID>: …")` block per row, asserting its acceptance case |
| `__tests__/se1-ledger.test.ts` | Ledger invariants. Prints one `todo` per row with no acceptance block |

The old `holdFoldConfidence` and `nearDuplicates` in `lib/shared/se1-dossier.ts` are marked `@deprecated` and left in
place; nothing in `app/` or `components/` calls them. Their replacements are `holdFoldEvidence` and `assessDuplicates`.

## 2. Check the current state (any agent, any time)

**Step 1: open slots.** Paste:

```bash
cd ~/code/nuwrrrld-portal-se1-ledger80 2>/dev/null || cd ~/code/nuwrrrld-portal
node_modules/.bin/vitest run --project unit __tests__/se1/ __tests__/se1-ledger.test.ts 2>&1 | grep -E "Test Files|Tests "
```

Expect `Tests 170 passed | 5 todo` on this branch. The 5 todos are C9, D4, E1, E3 and F1.

**Step 2: what each lane may pick up.** Paste:

```bash
npx tsx -e 'import("./lib/shared/se1-ledger.ts").then(({ rowsForLane }) => { for (const l of ["small","intermediate","large"]) console.log(l, rowsForLane(l).map((r) => `${r.id}[${r.blockers.join("+")}]`).join(" ")); })'
```

Expect three lines: 47 small, 21 intermediate and 12 large rows, each with its blockers.

## 3. What blocks the rest

Counts are rows out of 80; one row can have several blockers.

| Blocker | Rows | Who unblocks it |
|---|---|---|
| `results_store`: no real scan rows exist (decision D1) | 49 | Adam |
| `model_call`: narration needs a budget and the J2 gate on its path | 34 | Intermediate agent, after D1 |
| `auth_entitlement`: private data, entitlements or auth | 23 | Large agent drafts, Adam approves (T6) |
| `owner_decision` | 16 | Adam |
| `caller_wiring`: logic exists, no caller | 15 | Small or intermediate agent |
| `mobile_native`: needs a gcp3-mobile device build | 11 | Mobile maintainer |
| `eval_harness`: needs E3 evidence; no card is above E0 | 8 | Evaluation maintainer |
| `fundamentals_feed` 6, `push_consent` 6, `earnings_feed` 4, `ownership_macro_feed` 2, `news_feed` 1 | | Source approval by Adam |

Only 12 rows are blocked by nothing beyond wiring or the results store: A3, B2, B7, C4, C9, D4, D9, F1, F2, G3, J4, J5.
**A3 is the one row that can go live today**, because it needs no data.

## 4. Work a small model can do now

Each task stays inside T1/T2 limits (about 5 files and 200 lines, no auth, billing, schema, CI or dependency change).
Work in your own worktree. Stage by explicit path.

> **Done on this branch (second commit):** A3, A2, B2 and G3 are wired on web (`integrated` in the ledger).
> A3 renders citations on `/scans/[id]`; A2 adds an "ask which scan" box to `/scans`; B2 and G3 are the
> `/scans/dossier/[ticker]` page, built from stored Alpaca SIP daily bars. Verified locally against production data,
> read-only: AAPL and NVDA return 260 bars as of 2026-11-13; an unknown ticker shows "Not enough data".
> Known weakness: A2's word-overlap matcher can pick a related card instead of the best one (the question
> "is the 50 day above the 200 day" matched the close-under-200 card). Task S1 below is kept as the record of what was done.

### Task S1: wire A3 citations into the scan card (small, T2) — done

Outcome: scan IDs in a card's prose and caveats open the right card; an unknown ID shows as plain text marked
"unknown scan" and is never a link. This moves A3 from `logic_only` to `integrated` on web.

**Step 1: preflight.**

```bash
cd ~/code/nuwrrrld-portal && git fetch -q origin main \
  && git worktree add ../nuwrrrld-portal-a3-wire -b feat/se1-a3-wire origin/main \
  && cd ../nuwrrrld-portal-a3-wire && ln -s ~/code/nuwrrrld-portal/node_modules node_modules \
  && grep -n "resolveCitations" lib/shared/se1/ask.ts && grep -n "card.prose\|card.caveats" components/evidence/ScanCardView.tsx
```

Expect one `export function resolveCitations` line and two lines from `ScanCardView.tsx`. No output means this
branch has not merged yet: stop and wait for it.

**Step 2: change.** In `components/evidence/ScanCitations.tsx`, replace `splitCitations` with
`resolveCitations(text, SEED_CARDS)` (import `SEED_CARDS` from `@/lib/shared/se1-catalog`). Render
`type: "scan"` as the existing link, `type: "unknown_scan"` as `<span className="ev-cite-unknown"><code>{id}</code> (unknown scan)</span>`.
In `components/evidence/ScanCardView.tsx`, render `card.prose` and each caveat through `<ScanCitations text={…} />`.
In `lib/shared/ai-features.ts`, leave A3's status as `logic_only` until a reviewer approves, then set `web_only`.

**Step 3: verify.**

```bash
node_modules/.bin/vitest run --project unit __tests__/se1-catalog.test.ts __tests__/se1/ask.test.ts 2>&1 | grep -E "Tests "
node_modules/.bin/vitest run --project components 2>&1 | grep -E "Tests |FAIL" | head
node_modules/.bin/eslint components/evidence && node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -c "components/evidence"
```

Expect both test runs to pass and the last line to print `0`. Add a component test that renders a caveat
containing `se1.trend.not_a_real_card` and asserts no link points at it.

### Task S2: probe PR #352 before it merges (small, T2)

Outcome: the five logic features in #352 are checked against their acceptance cases, the way #374 was.

**Step 1: read each acceptance case.**

```bash
cd ~/code/nuwrrrld-portal-se1-ledger80 && grep -E 'id: "(C9|D4|E1|E3|F1)"' -A4 lib/shared/se1-ledger.ts | grep acceptance
```

Expect five lines.

**Step 2: get the PR's code without checking it out.**

```bash
cd ~/code/nuwrrrld-portal && git fetch -q origin pull/352/head:pr-352 \
  && git show pr-352:lib/shared/se1-roadmap2.ts | grep -nE "^export function"
```

Expect `holdFoldReasons`, `topScansBehindAnswer`, `weakestLinks`, `portfolioRisk` and `regimeBanner`.

**Step 3: write one adversarial case per acceptance line** as a comment on #352 (fewer than three supported findings
stays fewer than three; a stale or noisy regime input gives unavailable or debounced state; missing assets never count
as zero risk; a holding with missing inputs is excluded and the exclusion explained; every reason resolves to a real row).
Post findings with `gh pr comment 352 --body-file <file>`. Do not push to #352.

**Step 4: after #352 merges**, add a `describe("C9: …")` (and D4, E1, E3, F1) block to the matching track test,
importing from `@/lib/shared/se1-roadmap2`, and set each row's `module` to `lib/shared/se1-roadmap2.ts` and `web` to
`logic_only` in the ledger. Then:

```bash
node_modules/.bin/vitest run --project unit __tests__/se1-ledger.test.ts 2>&1 | grep -E "Tests "
```

Expect `0 todo`.

### Task S3: copy the shared logic to mobile (small author, intermediate reviewer)

Outcome: gcp3-mobile has the same se1 logic, and the drift check keeps the two copies identical. This is
roadmap fix R14. Use **`/syncpr`** for this; it opens the pair of PRs in the right order.

Files, all byte-identical (they use relative imports, so the same `lib/shared/` layout works in both repos):

```text
lib/shared/ai-features.ts
lib/shared/se1-catalog.ts
lib/shared/se1-dossier.ts
lib/shared/se1-ledger.ts
lib/shared/se1/util.ts  ask.ts  dossiers.ts  council.ts  monitoring.ts  portfolio.ts  holdfold.ts  explain.ts  mobile.ts  external.ts  ops.ts
```

Add each path to `PAIRS` in `scripts/check-shared-drift.mjs` with `normalize: null`. Verify:

```bash
cd ~/code/nuwrrrld-portal && WEB_ROOT=. MOBILE_ROOT=../gcp3-mobile node scripts/check-shared-drift.mjs; echo "exit $?"
```

Expect `exit 0`. Copying code is not mobile parity: the ledger's `mobile` field stays `planned` until a screen calls it.

## 5. Work for an intermediate model

- **R15, registry as the ledger.** `lib/shared/ai-features.ts` still lists 20 entries with one `status`. Derive the
  registry's per-surface state from `LEDGER`, and add the test the audit asked for: an entry claiming `integrated` or
  higher on web fails unless a file in `app/` or `components/` imports its module.
- **First real dossier (after Adam decides D1).** B2's `momentumEntryDossier` takes plain bars. Feed it Alpaca SIP
  daily bars (see the market-data rule: Alpaca first, `adjustment=split`, `feed=sip`, record `source` and `feed`),
  then render it with B1's `deepDiveSections`, G3's `howWeKnow` and B7's `diffDossiers`. Fixture first; a real run
  only after D1.
- **D9 cap at integration.** `decideAlert` decides; the cap still needs one conditional write per ticker per local day.

## 6. Waiting on Adam

| Decision | Rows it unblocks |
|---|---|
| D1: the se1 results store | 49 rows, every `results_store` blocker |
| B9 PDF: build it or record the scope change | B9 |
| Source approval: fundamentals, earnings, ownership/macro, news | B3–B6, C8, D5, E7–E9, A1 |
| Auth and entitlement activation (T6) | A8, B8, E5, H4, H8, I2–I9, J6, J8 |

## 7. Rules for every agent on this list

1. Do not edit a row's `acceptance` text to make a test pass. If the acceptance case is wrong, ask Adam.
2. A row moves to `integrated` only with a caller in `app/` or `components/` and a test of that caller.
3. Never wire a row whose blockers include `auth_entitlement` or `owner_decision`. Draft it and flag Adam.
4. One unit of work per branch and PR, in its own worktree. Stage by explicit path; never `git add -A`.
5. Higher tiers keep their gates: a T2 change needs an independent reviewer before merge, and uncertainty escalates.
6. Unrelated failures seen on this branch's base: `__tests__/nvidia-scenarios.test.ts` fails on main since the blog
   section merged (#329), and `tsc` reports `firebase-admin` missing in a shared local `node_modules`. Neither touches se1.
