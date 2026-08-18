# Docs Inventory — What's Here, Sensitivity, and What to Do With It

A full pass over every doc in the repo (tracked + untracked, `docs/`, root-level,
`.claude/commands/`, `corpus/`, `file-archive/`) as of 2026-08-17. For each: is
there sensitive content, should it be git-ignored, and does it belong in
`docs/wiki-portal/` (synthesized) or `docs/archive/` (preserved verbatim,
superseded).

**Secret scan result: clean.** Grepped every file for real key-shaped patterns
(`sk_live_`/`sk_test_`/`sk-ant-`/`sk-or-v1-`/`whsec_`/Postgres connection
strings with embedded credentials/`AIza...`). The only matches anywhere were
four mentions of the literal string `whsec_placeholder*` — a deliberately fake
value used to illustrate the placeholder-detection pattern, not a real secret.
Nothing here needs rotation or urgent git-ignoring on secret-content grounds
alone. (Separately, `docs/env-rotation.md` already tracks real credentials
that *were* exposed via an editor session, unrelated to any file below.)

---

## Already correctly handled — no action needed

- **`docs/wiki-portal/`** (45 pages) — the canonical, LLM-maintained knowledge
  layer. Working as designed; not covered further below except where a
  specific plan doc should feed it.
- **`docs/archive/e2e-b.md`, `docs/archive/e2e-git-a.md`** — already archived
  correctly this session, with `ARCHIVED:`/`REASON:` headers per the
  archive-never-delete policy. Untracked but should be committed alongside
  whatever PR touches `docs/e2e.md` next.
- **`file-archive/`** (`deploy-cloudflare.yml`, `deploy-fix-log.md`,
  `deploy-to-cloudflare.sh`, `wrangler.jsonc`) — the established non-doc
  archive location (per user's global CLAUDE.md convention). Correctly placed.
- **`.claude/commands/*.md`** — live slash-command definitions, not
  documentation to archive. `pr-nwf.md` (renamed from `pr.md` this session) is
  current.
- **`corpus/README.md`, `corpus/sample/*.md`** — grounding-corpus source
  material and its own README; functionally different from project docs,
  outside this inventory's scope.

---

## Recommend: archive to `docs/archive/` (superseded by the wiki or by later docs)

These describe work that has since shipped and is now the wiki's job to track,
or are earlier drafts superseded by a later doc in the same lineage. None
contain secrets. Archiving (not deleting) preserves the historical
reasoning per the project's own policy.

| File | Why archive | Superseded by |
|---|---|---|
| `docs/portfolio-health-fix-plan.md` | 3-phase fix plan for defects now resolved and documented as an incident | `docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md` |
| `docs/portfolio-health-ai-workflow.html` | Full-stack trace + 11/13-defect catalogue predating the fix | Same incident page; already linked *from* it as a "See also" — keep the link, archive the source |
| `docs/nulogdash-dashboard-plan.md` | Plan for `/nulogdash` — the dashboard now exists and is live-documented (`app/dashboard/nulogdash/`, `lib/nulogdash.ts`) | `docs/wiki-portal/entity-dev-command-suite.md` + the new `docs/wiki-portal/entity-playwright-e2e.md` (browser-tier merge) |
| `docs/nulogdash-admin-console-plan.md` | Plan for turning the `nulogdash-admin.html` prototype into a real console — the real console (with MFA gate, `canPerformAdminAction`) has shipped | `docs/clerk-todos.md` (tracks what's *still* open) + the wiki's billing/admin coverage |
| `docs/nulogdash-admin.html`, `docs/nulogdash-admin-site.html`, `docs/nulogdash-admin.css` | Static HTML prototypes of the admin console, pre-implementation | The real `app/dashboard/nulogdash/page.tsx` |
| `docs/full-sync-plan.md` | 2026-08-08 snapshot; its own header says "full detail lives in the wikis" | `docs/wiki-portal/concept-mobile-web-parity.md` + `concept-sync-requirements.md` (both kept current every PR) |
| `docs/full-sync-roadmap.md` | Same lineage as above, same date — appears to be a duplicate/near-duplicate of `full-sync-plan.md`; diff the two before archiving both, one may just be a stray copy | Same as above |
| `docs/sync-pr-large-scale-run.md` | A specific historical `/sync-pr` run's 12-step runbook — record of one past execution, not a living doc | Nothing supersedes it; it's just done. Archive as a completed-run record. |
| `docs/live-data-wiring.md` | 2026-06-27, "Kill the Wiring up / stale UI" — oldest doc in the set; check whether this work shipped | If shipped: archive. If not: this is a real open item and should move to a TODO or the wiki's "not yet documented" list instead. |
| `nextphase.md` | 2026-06-27 dashboard interactivity plan | Check against current `app/dashboard/` — likely shipped and archivable |
| `nu1.md` | 2026-07-09 track-record/backtest status update from a worktree branch | `docs/wiki-portal/entity-backtest-engine.md` now covers this canonically |
| `TODO.md`, `TODO2.md`, `TODO3.md`, `TODO4.md` | Sequential hardening passes on the `pending_signals` loop (2026-07-24), explicitly built on each other, TODO4 says "ship the three deferred items" | `docs/wiki-portal/decision-pending-signals-queue.md` and `entity-signal-data-plane.md` — confirm TODO4's deferred items are either done or tracked, then archive all four as a set (they're one continuous document split across four files) |
| `LANDING-REVAMP.md`, `LANDING-PHASE3-4.md` | Landing-page copy/build plan; header says "Phase 1+2 shipped in PR #42" | Check if Phase 3+4 also shipped; if so, archive both together |
| `docs/dev-data-hydration.md`, `docs/dev-data-hydration-findings.html` | Dev-seeder design + its findings doc | Likely done (the seeder exists per `scripts/`) — verify, then archive the pair together |
| `docs/findings-neon-and-stray-files.html` | Point-in-time audit findings (already referenced in `wiki-portal/log.md`'s PR #58 entry as "committed") | Its useful findings are already logged; archive the raw HTML |
| `docs/findings-signal-loop-hardening.html` | Same shape — a findings doc from a specific pass | Archive; extract anything not yet in the wiki first |
| `docs/stripe-checkout-incident-fix-steps.html` | Fix-steps doc for a Stripe incident | `docs/wiki-portal/incident-2026-07-27-stripe-checkout-invalid-header.md` almost certainly already covers this — diff before archiving to confirm nothing's missing |
| `docs/cloudflare-pages-assessment.md` | "Keep or Kill?" decision doc, dated 2026-07-24 | This reads as a **decision**, not a plan — if the decision was made, it belongs as `docs/wiki-portal/decision-cloudflare-pages-*.md`, not archived as dead weight. Check outcome first. |
| `docs/storage-structure.html` | Storage/schema documentation | Check against `lib/db/schema.sql` for staleness; likely superseded by the schema file itself as source of truth |
| `docs/nuwrrrld-portal-import/*` (5 files) | Explicitly labeled "import" — copied from a worktree/other location, several marked "INCOMPLETE" or "as of" a past date | These read as raw source material, not living docs. **Consider moving this whole folder to `docs/wiki-portal/raw/`** (the SCHEMA-defined immutable-source folder, currently empty/nonexistent) rather than `docs/archive/` — they're closer to wiki *inputs* than to superseded output. |
| `docs/todo1.md` | Single-topic TODO (consent checkboxes for both apps), 2026-06-27 | Check if implemented; if so, archive; if not, this is a real open item worth its own tracked TODO, not buried here |

---

## Recommend: keep active, but two need attention

| File | Status |
|---|---|
| `docs/ai-architecture.md` | 2026-08-16, actively current — describes how the app uses LLMs. Keep. Consider whether this should *be* a wiki overview page rather than a separate doc; check for drift against `docs/wiki-portal/overview.md` and `entity-ai-council.md`. |
| `docs/ai-production-test-suite.md` | 2026-08-16, describes testing AI in production. **Now has real overlap with `docs/e2e.md` and `entity-playwright-e2e.md`** (this session's work) — read both together and either merge or cross-link explicitly before they drift apart. |
| `docs/clerk-stripe-auth.md` | 2026-07-30. Some content may now be stale relative to `docs/clerk-todos.md` and `docs/wiki-portal/entity-billing.md` (both more recently touched, 2026-08-17). Diff before trusting. |
| `docs/local-fullstack-testing-guide.md` | 2026-08-16, "generic reusable playbook" — check for overlap/conflict with `docs/e2e.md` and `docs/local-check.md`-equivalent tooling; three docs describing "how to test this stack locally" is one too many if they've drifted. |
| `docs/admin-totp-plan.md` | 2026-08-17, current and active (referenced live from `docs/clerk-todos.md`'s P0 section). Keep — this is the canonical plan, not a candidate for archiving. |
| `docs/env-rotation.md` | This session's file, actively load-bearing (real credentials to rotate are tracked here). Keep, update as rotations complete. |
| `playwright-todo.md` | This session's file, active blocker-tracking. Keep. |

---

## Recommend: git-ignore or relocate (not project docs)

| Path | Reason |
|---|---|
| `docs/Recent Docs/` (whole folder) | Mixed contents: 5 files are genuine 2026-08-12 NuWrrrld planning docs (`nuwrrrld-10x-robustness-plan.md`, `nuwrrrld-adaptive-engine.md`, `nuwrrrld-pain-point-solutions.md`, `nuwrrrld-small-model-engine.md`, `how-i-use-zo.md`, `admin-and-tests.html`) — these belong under `docs/` proper or archived, not in a loosely-named catch-all folder. The other 3 (`Ulysses - Joyce Notes Outline.md`, `AI Trading Apps - 10 Market Gap Ideas.md`, `AI Trading Guide - Stocks & Options.md`) are **not related to this codebase at all** — personal reading notes and general market-research content. Move the NuWrrrld-relevant 6 into `docs/` (or archive if superseded — `how-i-use-zo.md` was actively edited this session and should stay active), and either git-ignore or relocate the unrelated 3 out of the repo entirely. |
| `docs/test-index.html` | Generated artifact (this session's HTML test index, already published as an Artifact + committed to `docs/` per the artifact-and-local-html rule). Fine to keep as a durable local copy — not a candidate for git-ignore, since the rule specifically wants it committed. Listed here only for completeness. |
| `docs/nulogdash-inventory.json` | Generated by `scripts/nulogdash-inventory.mjs` — check whether this is meant to be regenerated on every `/nulogdash` run (in which case it arguably belongs in `.gitignore` alongside `.nulogdash/`) or is a committed snapshot of the feature catalogue (in which case tracked is correct). Current state: tracked. Worth an explicit decision either way rather than default. |

---

## Files with genuinely unclear status — needs a decision, not a scan

- **`docs/full-sync-plan.md` vs `docs/full-sync-roadmap.md`** — near-identical
  titles, same date (2026-08-08). Likely one is a stray duplicate of the
  other from a copy/rename. Diff them before archiving either.
- **`docs/live-data-wiring.md` and `docs/todo1.md`** — both read as *possibly
  still-open* work rather than shipped-and-archivable. Don't archive on
  autopilot; confirm against current `app/` code first, since archiving an
  open TODO as if it were done would hide real remaining work.

---

## What I did **not** do

This is a classification pass, not an execution pass — no files were moved,
archived, or git-ignored as part of writing this doc. Several of the
"recommend archive" items above need a one-line confirmation (mostly "did
this actually ship?") that only a look at current app code or your own memory
can answer quickly; I flagged where that check is needed rather than guessing.

## Suggested next step

If you confirm the "recommend archive" list, I can archive all of them in one
pass (headers + moves to `docs/archive/`, or `docs/wiki-portal/raw/` for the
`nuwrrrld-portal-import/` set) plus git-ignore the unrelated personal files in
`docs/Recent Docs/`. Say the word and I'll execute rather than just list.
