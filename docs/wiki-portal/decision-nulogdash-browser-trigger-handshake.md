---
date: 2026-09-08
type: decision
tags: [nulogdash, pipelines, security, server-actions, csrf, rate-limit, openrouter, cost]
sources: [../../lib/nulogdash-actions.ts, ../../lib/nulogdash-trigger.ts, ../../lib/pipeline-db-guard.ts, ../../app/dashboard/nulogdash/pipelines/page.tsx, ../../app/dashboard/nulogdash/pipelines/_components/TriggerControls.tsx, ../../scripts/local-trigger.mjs, ../admin-console-todo.md]
---

# decision: the nulogdash browser trigger is a dry-only → live-only two-action handshake, not a `dryRun` flag

## Decision

The `/dashboard/nulogdash/pipelines` tab can fire the three model-spending
pipelines from the browser via **two separate Server Actions**, not one
parametrised call:

- `triggerPipelineRun({ pipeline })` — **always** a dry run. On success it
  mints a single-use, 2-minute-TTL confirmation token keyed to
  `{pipeline, userId}` (in-process `Map`, same best-effort-on-serverless
  posture as `lib/rate-limit.ts`).
- `confirmLivePipelineRun({ pipeline, confirmToken, typedName })` — **always**
  a live run. It requires that token (burned on use), `typedName === pipeline`,
  a `DATABASE_URL` that does not resolve to `PRODUCTION_DB_HOST`
  (`assertNotProductionDb`, [[entity-dev-command-suite|shared with local-trigger.mjs]]),
  and rate headroom (`rateLimit`, 1 live run / pipeline / 5 min / user).

There is no `dryRun` boolean in either client payload. Both actions re-derive
identity and permission from the Clerk session on every call
(`auth()` → `currentUser()` → `canPerformAdminAction`, the MFA-gated check from
[[decision-self-implemented-totp-over-clerk-pro]] — not `isNulogdashAdmin`).
The route itself is reached by a **loopback `fetch`** with the bearer secret
(`CRON_SECRET` / `PORTAL_PUSH_SECRET`) attached server-side; the client never
sees it. The client island (`TriggerControls.tsx`) holds no auth, no secret,
and no `fetch`.

## Date

2026-09-08 (`feat/pipeline-local-runs-fixes`; design in `../admin-console-todo.md` §5)

## Context

Everything under `app/dashboard/nulogdash/**` was read-only server components —
nothing in a browser session could spend OpenRouter quota or write a row. A
"run" button removes that property. The governing rule was stated once:

> The browser must never be able to do something `scripts/local-trigger.mjs`
> would have refused.

The CLI defaults to `dry_run: true` and refuses `--no-dry-run` without `--yes`.
A single action taking `{ pipeline, dryRun }` reproduces the CLI's shape but
not its safety: the client controls `dryRun`, and "fail closed on a missing
boolean" is one refactor away from failing open.

## Alternatives considered

- **One action, `dryRun` defaulting to `true` server-side.** Rejected: the
  client still names the outcome. Every future edit to that default is a
  chance to invert it; a reviewer has to re-derive "can the client reach the
  live branch?" each time.
- **`window.confirm()` / a modal before a live call.** Rejected: a modal the
  client can skip is not a control (`../admin-console-todo.md` §5.4). The
  confirmation has to be *server-verified state*.
- **Call the pipeline logic directly instead of a loopback HTTP hop.** Rejected
  for now: the routes are `POST(req: NextRequest)` handlers doing their own
  bearer check and body parsing; a loopback call reuses that contract exactly
  and matches how `local-trigger.mjs` Path C already exercises them. The cost
  is one extra in-process request.
- **A separate lightweight admin SPA.** Rejected in `../admin-console-todo.md`
  §6: it would have to re-implement session auth, secret handling, CSRF, and
  the admin gate — four properties the in-app Server Action gets for free — and
  adds a second origin and deploy while removing nothing.

## Consequences

- **Server Actions, not a hand-rolled `POST`**, so Next's built-in same-origin
  check covers CSRF on a spend endpoint with no new public route.
- **The two-call token dance is the browser's `--yes`.** A one-shot live fire
  is structurally impossible: a live run always follows a completed dry run
  within 2 minutes, by the same user, for the same pipeline, plus a typed
  match.
- **`pipeline_run_log.session` gains attribution** — the action passes
  `nulogdash:<primary email>`, so [[entity-model-usage-log]] can answer "who
  fired this live run". `followed-tickers-judge` and `precompute-ai` gained an
  optional `session` body field for this (`followed-tickers` already had one).
- **First real consumer of `canPerformAdminAction`.** With `twoFactorEnabled`
  permanently `false` on the free Clerk tier, the buttons render for nobody and
  the tab is dry-run-only until [[decision-self-implemented-totp-over-clerk-pro]]
  ships. The gate stopped being vacuous; it started being *blocking*.
- **In-process limits, not distributed.** The confirm-token `Map` and the rate
  limiter are per-instance and reset on cold start — enough to force deliberate
  use and stop a double-click, not a hard quota. A hard cap is the
  Redis/Upstash conversation `lib/rate-limit.ts` already flags.
- **`PRODUCTION_DB_HOST` must be set for the prod-DB refusal to bite.** The
  guard is opt-in and only warns until then (`../manual-setup-todo.md` §9).

## Validated by

`__tests__/nulogdash-actions.test.ts` — 10 cases: non-admin rejected,
admin-without-MFA rejected, unknown pipeline rejected, dry-run wiring (route +
secret + body), non-2xx surfaced, live call without a valid token rejected,
typed-name mismatch rejected, `PRODUCTION_DB_HOST` match refused, second live
call inside 5 min rate-limited, token burned after one use. `npm run build`
green (`ƒ Proxy (Middleware)` present). Live browser end-to-end by an
MFA-enrolled admin is still unverified — it needs MFA, which is
[[decision-self-implemented-totp-over-clerk-pro]].

## See also

- [[entity-model-usage-log]] — the `pipeline_run_log` table these buttons write, and its new request-path readers
- [[decision-self-implemented-totp-over-clerk-pro]] — the MFA gate the buttons render behind
- [[entity-dev-command-suite]] — `scripts/local-trigger.mjs`, the CLI trigger path this mirrors, and the shared `PRODUCTION_DB_HOST` guard
- [[entity-clerk]] — `proxy.ts` (ex-`middleware.ts`) route protection, renamed in the same change
- `../admin-console-todo.md` — the §1–§5 checklist this closes
- `../admin-console-trigger-guide.html` — operator-facing guide + security-risk table
