# nulogdash — Plan

A plan for `/nulogdash`: a slash-command in the spirit of `/local-check`
(`.claude/commands/local-check.md`), but harder-edged — instead of checking
that the *layers* (CLI auth, env vars, DB) are reachable, it actually drives
every user-facing feature end-to-end from the frontend, and every run's
results land on a dashboard page in the portal itself. This doc is a plan
only; nothing here is implemented yet.

## Why `/local-check` isn't enough

`/local-check` answers "is the stack ready to test against" — auth, env
vars, DB migration status, one backend health ping, the fast unit suite. It
never actually calls `/api/holdfold`, submits a Stripe checkout, or asks Nu
AI a question. A layer can pass every `/local-check` gate and still have a
broken feature (bad prompt, broken parsing, a route that 500s only under a
real session). `nulogdash` closes that gap: it is a feature-level E2E
sweep, and — unlike `/local-check`'s terminal-only report — it persists
results somewhere the team can see trend/history, not just the latest run.

## What "end-to-end" means here

Not a curl to `/health`. For each feature, the minimum bar to count as
"run end-to-end" is: authenticated request → real route handler → real
downstream dependency (GCP backend / DB / OpenRouter / Stripe test mode) →
response shape validated. A request that 200s because a downstream call was
mocked or skipped does **not** count — it must be flagged separately as
"reachable, not exercised."

## Feature inventory to exercise

Derived from the dashboard tool-grid (`app/dashboard/page.tsx`) and the
route tree under `app/api/`:

| Feature | Entry point(s) | Requires |
|---|---|---|
| Sign-in / session | Clerk sign-in flow | Clerk test instance |
| Signal Digest | `/api/signals/digest`, `/api/signals/live`, `/api/signals/refresh` | session, GCP backend |
| Signal card / share | `/api/signals/card`, `/api/signals/[ticker]/chat`, `SignalShareButton` | session |
| Nu AI | `/api/nuai` | session, OpenRouter key |
| Hold / Fold | `/api/holdfold` | session, GCP backend |
| Portfolio Intel | `/api/portfolio/health`, `/api/portfolio/health-ai`, `/api/portfolio/suggestions`, `/api/portfolio/watchlist[/ticker]` | session, DB |
| Share & Earn | `/api/referral` | session, DB |
| Billing — checkout | `/api/stripe/checkout` | session, Stripe test mode |
| Billing — portal | `/api/stripe/portal` | session, Stripe test mode, active test subscription |
| Billing — webhooks | `/api/webhooks/stripe`, `/api/webhooks/clerk` | `stripe listen` forwarder running |
| Retention | `/api/retention/streak`, `/api/retention/trial-nudge`, `/api/retention/digest-email` | session, DB |
| Council | `/api/council`, `/api/council/deliberate`, `/api/council/sample`, `/api/council/public` | OpenRouter key |
| Backtest | `/api/backtest/[symbol]` | GCP backend |
| Push notifications | `/api/push/register` | session |
| Launch reminder | `/api/launch/remind` | none |
| OG image | `/api/og/verdict` | none |

Anything not on this table when the command is written is itself a gap —
step 1 of building `/nulogdash` is generating this table from the route
tree programmatically, not hand-maintaining it, so new routes don't
silently fall outside the sweep.

Routes that are deliberately out of scope must be declared, not omitted:
webhook receivers are only exercisable with `stripe listen` running, and
`/api/signals/drain` and `/api/retention/digest-email` have side effects
(draining a queue, sending mail) that shouldn't fire on a routine sweep.
Keep an explicit `excluded` list with a reason per entry, and render it on
the dashboard alongside the failures — an intentional exclusion and an
accidental omission look identical in a report that only lists passes.

## Statuses: four outcomes, not two

Pass/fail is too coarse to be actionable here, and collapsing the middle
cases into "fail" is what makes a report like this get ignored:

| Status | Meaning | Dashboard treatment |
|---|---|---|
| `pass` | Ran end-to-end, response shape validated | green |
| `fail` | Ran, but errored or returned an invalid shape | red — this is a bug |
| `blocked` | Couldn't run: missing env var, expired CLI auth, backend down | amber — fix the environment, not the code |
| `not_run` | Tier not attempted, feature excluded, or route absent from inventory | grey — coverage gap |

The distinction that matters most is `fail` vs `blocked`. A missing
`OPENROUTER_API_KEY` turning every AI route red trains you to ignore red;
it belongs in amber with a pointer to
`docs/local-fullstack-testing-guide.md` §2. Detect `blocked` by running the
`/local-check` preflight gates first and mapping each unmet gate to the
features that depend on it — the sweep should skip those features with a
recorded reason rather than firing doomed requests.

## How each feature gets driven

Two tiers, and the report must say which tier each feature ran at:

1. **API-level** (default, fast): authenticated `fetch`/`curl` against the
   route with a real Clerk test-session token (`clerk` CLI can mint one for
   a test user) and real request bodies. Covers route handler + downstream
   dependency, not client rendering.
2. **Browser-level** (opt-in, slow): a Playwright/browser-use pass that
   actually clicks through the dashboard UI — sign in, navigate each
   tool-grid card, submit the billing checkout form in Stripe test mode.
   Covers what API-level can't: client-side state, CORS, broken links,
   rendering errors that never hit the network.

Default `/nulogdash` run = tier 1 for every feature in the table. Tier 2 is
opt-in (`/nulogdash --browser`) because it's slow and the repo already has
a `browser-use` skill capable of driving it.

## Persisting run results

`/local-check` only prints to the terminal, which is why nothing shows up
on a dashboard. `nulogdash` needs a durable sink the Next.js app can read
at request time. Options, ranked:

1. **New Neon table `nulogdash_runs`** (recommended) — columns: `id`,
   `run_at`, `git_sha`, `feature`, `tier` (api/browser), `status`
   (pass/fail/not_run), `latency_ms`, `error_summary`, `run_id` (groups rows
   from one invocation). Matches how the rest of the app already talks to
   Neon (`lib/subscription.ts` etc.), and a Next.js server component can
   query it directly with no new infra.
2. Firestore, mirroring `locrun.py`'s `scans`/`summaries` pattern — makes
   sense only if `nulogdash` and `locrun` end up sharing infrastructure
   later; skip for now, this is a portal-only concern.
3. A local JSON file under a git-ignored `.nulogdash/` dir — simplest to
   build, but useless as soon as the dashboard needs to run anywhere other
   than the machine that ran the command. Fine as a v0 stepping stone,
   not the destination.

Decision needed before implementation: start at v0 (local JSON) to prove
the dashboard page, then migrate to the Neon table once the schema settles
— or go straight to Neon. Recommend the former; the dashboard component
shouldn't care which sink it reads from if the query layer is a thin
`getLatestRun()` / `getRunHistory()` module from day one.

Whichever sink wins, the record shape stays the same so the migration is a
driver swap:

```ts
interface FeatureResult {
  feature: string;          // stable slug, e.g. "portfolio-health-ai"
  entrypoints: string[];    // routes actually called
  tier: "api" | "browser";
  status: "pass" | "fail" | "blocked" | "not_run";
  latencyMs: number | null;
  reason: string | null;    // why blocked/not_run, or the error summary
  dependencies: string[];   // "gcp-backend" | "neon" | "openrouter" | "clerk" | "stripe"
}

interface Run {
  runId: string;            // groups FeatureResults from one invocation
  runAt: string;            // ISO-8601
  gitSha: string;
  branch: string;
  tiers: ("api" | "browser")[];
  results: FeatureResult[];
  excluded: { feature: string; reason: string }[];
}
```

`reason` is free text and will contain upstream error bodies — scrub it
before it's persisted or rendered. Stripe and Clerk errors routinely echo
request context, and a run record that lands in Neon and then on a page is
a worse leak path than a terminal line that scrolls away. Truncate to a
sane length and redact anything matching key-shaped patterns
(`sk_`, `whsec_`, `pk_`, bearer tokens) at write time, not render time.

## The dashboard page

New route, internal-only (not linked from the public tool-grid):
`app/dashboard/nulogdash/page.tsx`, gated the same way `/dashboard/beta` is
gated today (check the existing gating pattern there before inventing a
new one — likely a role/email allowlist rather than a new auth concept).

Contents:
- **Latest run summary** — pass/fail counts, run timestamp, git SHA, total
  duration.
- **Feature matrix** — one row per feature from the inventory table above,
  columns: status (pass/fail/not run), tier exercised, last-pass timestamp,
  error summary (collapsed, expandable).
- **Explicit "not run end-to-end" section** — every `blocked` and
  `not_run` feature from the latest run, each with its recorded reason, plus
  the declared `excluded` list. This is the part `/local-check` has no
  equivalent of and is the actual point of `nulogdash` — silence about
  untested surface area is the failure mode being fixed. Show it as a
  headline count ("7 of 16 features not exercised end-to-end") above the
  matrix, not buried below it; a green matrix with a quiet footnote is
  exactly the false confidence this is meant to prevent.
- **Run history** — sparkline or simple table of the last N runs per
  feature, once the sink is durable enough to support it (Neon tier, not
  v0 JSON).

The page re-renders fresh data on every load (no `revalidate` caching) —
it exists to be checked right after a `/nulogdash` run, and stale results
would defeat the purpose.

## `/nulogdash` command shape (draft)

```markdown
---
description: Run every portal feature end-to-end and log results for the nulogdash dashboard
argument-hint: "[--browser] [--feature <name>]"
allowed-tools: Bash
---
```

Execution outline:
1. Generate/refresh the feature inventory from `app/api/**/route.ts` +
   `app/dashboard/**/page.tsx`, diff against the hand-maintained table above
   and flag any drift.
2. Mint a Clerk test session token for a dedicated test user.
3. For each feature: fire the tier-1 request(s), record status/latency/
   error, write a row to the run sink.
4. If `--browser`: run the Playwright/browser-use pass for tier 2, same
   recording.
5. Write a run summary row, then report the same pass/fail table
   `/local-check` reports today, plus the URL of the dashboard page and an
   explicit line: "N of M features not run end-to-end this pass: [list]."

## Open decisions before building

- Run sink: v0 local JSON vs. Neon table from the start (recommend v0 →
  Neon, see above).
- Test identity: a dedicated Clerk test user + Stripe test customer that
  persists across runs, vs. minting a throwaway one per run. Persistent is
  cheaper and lets retention/streak features be tested meaningfully.
- Dashboard gating mechanism: reuse whatever `/dashboard/beta` uses, don't
  invent a second internal-access pattern.
- Cost/quota: tier-1 sweep hits OpenRouter and GCP backend for real on
  every run — needs the same scoped/low-quota key guidance
  `docs/local-fullstack-testing-guide.md` §5 already gives, so `/nulogdash`
  shouldn't be wired into a tight loop (e.g. not on every save).
- Write-side test data: watchlist add/remove, referral creation, and push
  registration all mutate real rows. Either scope every write to the test
  user and clean up in a teardown pass, or accept accumulating rows and
  namespace them so they're trivially deletable. Decide before step 2 —
  retrofitting cleanup onto a sweep that's already been run a hundred times
  is worse than designing it in.

## Acceptance criteria

The build isn't done until:

- A `/nulogdash` run reports a status for **every** route in
  `app/api/**/route.ts` — no route is silently absent; unlisted routes
  surface as `not_run` with reason "not in inventory."
- Adding a new API route and re-running produces a `not_run` row for it
  without anyone editing the inventory by hand.
- A deliberately broken route (e.g. temporarily throwing in
  `/api/holdfold`) shows `fail`, while unsetting `OPENROUTER_API_KEY` shows
  `blocked` for AI features only — the two are visibly different.
- The dashboard page renders the latest run within one page load of the
  command finishing, with no manual cache bust.
- No secret-shaped string appears in any persisted `reason` field, verified
  against a run where an upstream call failed with a real error body.

## Build phases

1. Generate the feature inventory programmatically; commit it as a checked
   file so drift is visible in diffs.
2. Build `/nulogdash` tier-1 only, writing to local JSON; prove the loop
   manually.
3. Build the dashboard page reading from that JSON via a `getLatestRun()`
   abstraction.
4. Migrate the sink to the Neon `nulogdash_runs` table; add run history to
   the dashboard.
5. Add tier-2 (`--browser`) using the existing `browser-use` skill.
