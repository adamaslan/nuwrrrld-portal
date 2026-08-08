# Large-Scale `/sync-pr` Run — 12-Step Mobile Sync Runbook

Drives many changes through
[`.claude/commands/sync-pr.md`](../.claude/commands/sync-pr.md) as one
coordinated campaign to bring the **mobile app** (`gcp3-mobile`) into sync with
the **web portal** (`nuwrrrld-portal`). Planned, sequenced, and tracked as 12
explicit steps so the parity matrix stays consistent across the whole sweep.

**The goal of this batch is mainly a single-surface mobile fix — getting
mobile caught up to code that already exists on the portal**, not inventing
new cross-surface features. Most items in the queue (§1 de-drift work per
`concept-sync-requirements.md`) are exactly this shape: the portal already has
the code (`parseSubscriptionMetadata()`, `signal-policy.ts`, etc.); mobile is
the surface that's behind. In that common case, the item is a **mobile-only
PR** — per `sync-pr.md`'s own guidance ("for single-surface changes use each
repo's `/pr` instead"), don't force a paired portal PR with nothing to put in
it. Item #1 (`fix/subscription-metadata-parity`, mobile PR #29) confirmed this
pattern: portal needed zero changes.

Use the full dual-repo `/sync-pr` flow (both PRs, cross-linked) only for items
that actually touch both surfaces — e.g. item #4's CI drift gate, or any future
port/converge item from `concept-sync-requirements.md` §2–3 that adds new
behavior to both apps rather than just catching mobile up.

**This is a runbook, not a shortcut.** Every rule in `sync-pr.md` still holds
per item: pre-flight build both repos, secret scan before every commit, wiki
ingest into **both** wikis regardless of whether the item is one PR or two.

## Repos (from `sync-pr.md`)

| Surface | Path | Repo (`gh --repo`) | Base |
|---|---|---|---|
| Web | `/Users/adamaslan/code/nuwrrrld-portal` | `adamaslan/nuwrrrld-portal` | `main` |
| Mobile | `/Users/adamaslan/code/gcp3-mobile` | `adamaslan/gcp-expo1` | `main` |

Shared core is canonical in `gcp3-mobile/lib/`; the mirror is
`nuwrrrld-portal/lib/shared/…`. Byte-identical except the base-URL seam.

---

## The 12 Steps

### Step 1 — Orient in both wikis
Read `docs/wiki-portal/START-HERE.md` and the mobile twin
`gcp3-mobile/docs/wiki-mobile/`. Read `concept-wiki-led-development.md`. This is
the wiki-led "orient before you change" step from `sync-pr.md §0`.

### Step 2 — Capture the parity baseline
Read `concept-mobile-web-parity.md` in **both** wikis. Record the current
headline **% synced** and the full domain-by-domain matrix — this is the
baseline the batch will move. Note every row where mobile is behind web (the
drift/port backlog in `concept-sync-requirements.md`).

### Step 3 — Confirm clean, green baselines
Both trees clean, on a known base, and building before you touch anything:
```bash
git -C /Users/adamaslan/code/nuwrrrld-portal status --porcelain
git -C /Users/adamaslan/code/gcp3-mobile     status --porcelain
cd /Users/adamaslan/code/nuwrrrld-portal && npm run build   # expect "ƒ Proxy (Middleware)"
cd /Users/adamaslan/code/gcp3-mobile     && npx tsc --noEmit
```
If either baseline is dirty or red, stop and resolve before starting.

### Step 4 — Define the batch queue
Fill in the queue (§Batch queue below). One small, independently-shippable
cross-surface change per row. Order matters: shared-core / foundational items
first, so later items build on a settled mirror; put file-sharing items adjacent.

### Step 5 — Select the next item
Pick the top ☐-pending row whose dependencies are all ✅. Mark it ▶ in-progress.
Work items **serially** — never branch the next item until the current item's
two PRs are open and cross-linked, so the mirror is settled first.

### Step 6 — Pre-flight the item
Re-run the build/tsc from Step 3, then run the `diff` drift guard on each shared
file the item touches — only the base-URL seam may differ:
```bash
diff <(sed 's#<web-base-url>#<seam>#' nuwrrrld-portal/lib/shared/<f>) \
     gcp3-mobile/lib/<f>
```
Don't open PRs against a broken build.

### Step 7 — Commit mobile first (canonical shared core)
Mobile carries the canonical `lib/`. Secret-scan, then explicit add + commit:
```bash
git -C /Users/adamaslan/code/gcp3-mobile diff | grep -iE \
  "(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|CLERK_SECRET|AWS_SECRET|SUPABASE_KEY|sk_live)" \
  && { echo "⚠️  SECRETS — abort item"; } || echo "✅ clean"
git -C /Users/adamaslan/code/gcp3-mobile status --porcelain | grep -E '\.env($|\.local)' \
  && { echo "❌ .env present — abort"; } || true
git -C /Users/adamaslan/code/gcp3-mobile checkout -b <branch-name>
git -C /Users/adamaslan/code/gcp3-mobile add <specific safe files>   # never git add -A
git -C /Users/adamaslan/code/gcp3-mobile commit -m "<type>(<scope>): <desc>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
git -C /Users/adamaslan/code/gcp3-mobile push -u origin HEAD
```
Abort the item on any secret/`.env` hit.

### Step 8 — Commit the web mirror (same branch name)
Repeat the Step 7 scan + explicit-add flow in `nuwrrrld-portal` on the **same
branch name**, staging the mirror (`lib/shared/…`) and any web-side glue. Keep
the backend URL server-side (`HOLDFOLD_BACKEND_URL`, never `NEXT_PUBLIC_`).

### Step 9 — Open a PR per repo that actually changed
If the item is a mobile-catch-up de-drift and the portal needed no edits (the
common case for this batch — see the note at the top of this doc), open
**one** PR against mobile only:
```bash
gh pr create --repo adamaslan/gcp-expo1 --base main --title "<title>" --body "<template>"
```
If the item genuinely touches both surfaces, open both:
```bash
gh pr create --repo adamaslan/gcp-expo1     --base main --title "<title>" --body "<template>"
gh pr create --repo adamaslan/nuwrrrld-portal --base main --title "<title>" --body "<template>"
```
Body carries the Summary + Security checklist from `sync-pr.md §3`. Any
`gh pr create` call fires the wiki-guard hook — expected.

### Step 10 — Cross-link (dual-PR items only)
For a two-PR item, once both URLs exist, `gh pr edit <n> --repo <repo> --body …`
to fill each `Pairs with:` with the sibling URL — both PRs or neither, since a
half-shipped dual item drifts the mirror. For a single-PR mobile-catch-up item,
there's nothing to cross-link — note in the PR body that the portal needed no
change (see PR #29 for the pattern). Record the URL(s) in the tracking table,
mark the row ✅, return to Step 5 until the queue is empty.

### Step 11 — Per-item wiki log
For each item shipped, append the `log.md` line in **both** wikis
(`## [{date}] ingest | PR #{n} {title} | pages touched: N`), update `index.md`
if it added pages, and touch any `entity-*/concept-*/decision-*` page the change
actually affects. (Defer the full parity recompute to Step 12.)

### Step 12 — Recompute parity once & close out
After the last item, recompute the headline **% synced** and the full domain
matrix in `concept-mobile-web-parity.md` **and** `concept-sync-requirements.md`
in **both** wikis to reflect the whole batch; confirm the two wikis' headline
numbers agree. Then verify:
```bash
node ~/.claude/scripts/wiki-lint.mjs  ~/code/nuwrrrld-portal/docs/wiki-portal \
                                      ~/code/gcp3-mobile/docs/wiki-mobile
node ~/.claude/scripts/wiki-guard.mjs
```
Close-out gate: every row ✅ or explicitly ⛔ with a reason · no half-shipped
item · parity agrees across both wikis · lint/guard clean · **nothing merged**
(merging one half still drifts the mirror — merge is a separate, deliberate step
via `/bugmerge1` / `/postbugmergerev`).

---

## Batch queue (Step 4 — filled from `concept-sync-requirements.md` §1 priority order)

| # | Branch name | Description | Shared files | Depends on | Status |
|---|---|---|---|---|---|
| 1 | `fix/subscription-metadata-parity` | Port `parseSubscriptionMetadata()` verbatim into mobile's `lib/subscription.ts` — mobile is missing the function entirely (portal PR #45 regression); restores byte-identical status | `lib/subscription.ts` | — | ✅ done — mobile PR #29, single-surface |
| 2 | `fix/prefs-signalfilters-parity` | Reconcile `lib/shared/signalFilters.ts` (pure quote-style + import-path drift, no logic change) and confirm `lib/shared/prefs.ts` differs only on the intended localStorage/SecureStore seam | `lib/shared/prefs.ts`, `lib/shared/signalFilters.ts` | #1 | ✅ done — portal PR #50, single-surface |
| 3 | `fix/digest-signalcard-parity` | Resolve the `adaptLiveSignals` error-handling split (throw vs. null) + field-mapping drift between `digest.ts`/`signalCard.ts` (open-issue #6) | `lib/digest.ts`, `lib/signalCard.ts` | #2 | ✅ done — mobile PR #30 + portal PR #51, dual-surface |
| 4 | `feat/shared-drift-ci-gate` | Add a checksum/diff CI gate so `lib/shared/` can't silently re-drift after items 1–3 land | (infra, no shared file) | #3 | ✅ done — mobile PR #31 + portal PR #52, dual-surface |

Status: ☐ pending · ▶ in-progress · ✅ both PRs open · ⛔ blocked.

Not queued as `/sync-pr` items: the AI Council convergence decision (`concept-sync-requirements.md` §3) is a recorded `decision-*.md`, not a code PR — handle separately. Ports (backtest, real-time price tier, observability) are lower-ROI per the priority order and are backlog, not this batch.

## Campaign tracking (Steps 10–11)

| # | Branch | Mobile PR | Web PR | Cross-linked | Wiki logged | Done |
|---|---|---|---|---|---|---|
| 1 | `fix/subscription-metadata-parity` | [gcp-expo1#29](https://github.com/adamaslan/gcp-expo1/pull/29) | n/a (single-surface) | n/a | ✅ | ✅ |
| 2 | `fix/prefs-signalfilters-parity` | n/a (single-surface) | [nuwrrrld-portal#50](https://github.com/adamaslan/nuwrrrld-portal/pull/50) | n/a | ✅ | ✅ |
| 3 | `fix/digest-signalcard-parity` | [gcp-expo1#30](https://github.com/adamaslan/gcp-expo1/pull/30) | [nuwrrrld-portal#51](https://github.com/adamaslan/nuwrrrld-portal/pull/51) | ✅ | ✅ | ✅ |
| 4 | `feat/shared-drift-ci-gate` | [gcp-expo1#31](https://github.com/adamaslan/gcp-expo1/pull/31) | [nuwrrrld-portal#52](https://github.com/adamaslan/nuwrrrld-portal/pull/52) | ✅ | ✅ | ✅ |

---

## Gotchas

- **Stay on the branch after any later merge**
  (`~/.claude/rules/stay-on-branch-after-merge.md`): don't `git checkout main`
  mid-campaign — branch the next item from `origin/main`
  (`git fetch origin main && git checkout -b <next> origin/main`).
- **Always branch item N from `origin/main`, never from item N-1's local
  branch or an old pre-existing local feature branch.** Items #1 and #2 of
  this batch were both branched from stale local branches
  (`feat/mobile-interactivity-batch`, `feat/wiki-led-automation-layer`) that
  weren't yet merged — their PRs ended up diffing 8–10 unrelated commits
  against `main` instead of just the intended change, because GitHub PR diffs
  are computed against the merge-base with `main`, not against whatever branch
  you happened to check out from. Caught late via `git log origin/main..HEAD`;
  fixed by re-branching item #3 with `git fetch origin main && git checkout -b
  <name> origin/main`. Run that ancestry check (`git log origin/main..HEAD
  --oneline` should show only your own commits) before opening any PR.
- If an item's Step 6 pre-flight goes red because a **prior** item changed a
  shared file, that's real drift — fix the mirror in the current item.
- Keep items independently revertable: rejecting item 3 must not unwind 1–2.
