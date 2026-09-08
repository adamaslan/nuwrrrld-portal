# Admin console TODO — nulogdash, pipeline runs, and how to safely add triggers

Everything still open on the `/dashboard/nulogdash` admin console, plus the
design answer to the question this file was created for: **should the admin
frontend be a separate lightweight React app, or built into the existing
Next.js app?**

Short answer, argued in §6: **build it into the existing app.** A separate SPA
would have to re-implement — and could only weaken — four security properties
this app already gets for free.

Written: 2026-09-08, after verifying
[docs/local-pipeline-runs-and-html-reports.md](local-pipeline-runs-and-html-reports.md)
end to end locally and building the pipelines tab.
Branch: `feat/pipeline-local-runs-fixes`.

Companion files — keep the boundaries straight:

| File | Holds |
|---|---|
| this file | admin-console work that is a **code change** |
| [manual-setup-todo.md](manual-setup-todo.md) | items blocked on a **human** (a login, a secret, a decision) |
| [local-pipeline-runs-and-html-reports.md](local-pipeline-runs-and-html-reports.md) | how the local run + report flow **works today** |

---

## 0. What is already built (do not re-plan these)

- **Feature sweep tab** — `/dashboard/nulogdash`, reads `.nulogdash/latest.json`.
- **Pipeline runs tab** — `/dashboard/nulogdash/pipelines`, reads
  `pipeline_run_log`: latest-run card per pipeline, 50-run table, dry-run/live
  badge per row.
- **Per-run detail** — `/dashboard/nulogdash/pipelines/[id]`: outcome cards,
  per-model rollup, every item's subject/seat/model/outcome/latency/fallback,
  raw `summary` blob.
- **Read layer** — `listPipelineRuns` / `getPipelineRun` / `summarizeOutcomes`
  in `lib/pipeline-run-log-db.ts`. Clamped limit (1–200), uuid-shape guard
  before the Postgres cast, and these **throw** rather than swallow (unlike
  `logPipelineRun`) because a dashboard silently showing "no runs" on a failed
  query is worse than one that errors.
- **CLI trigger + HTML report** — `scripts/local-trigger.mjs` Path C and
  `scripts/pipeline-run-report.mjs`. All three pipelines verified 200 in dry
  run locally on 2026-09-08.

Everything in that list is read-only. **Nothing in the browser can currently
spend money or write a row** — which is the property the rest of this file is
about not losing.

---

## 1. ✅ `middleware.ts` → `proxy.ts` (Next 16 deprecation) — DONE

**Done in this session's commit. Verify locally per the checklist below before
merging.**

Next 16.2.9 logs on every dev boot:

> ⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

`middleware.ts` is where `clerkMiddleware`, `auth.protect()`, the
`/dashboard(.*)` matcher, and the whole API-route auth classification live. It
works today via Next's compatibility shim (dev logs still show `proxy.ts` in
the timing breakdown, so the shim is already routing through the new path).

What the rename involves — per
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`:

- [x] `git mv middleware.ts proxy.ts` (repo root, same level as `app/`).
- [x] Confirmed `clerkMiddleware()` as the **default export** is valid under the
      `proxy` convention. Next's own doc: "The file must export a single
      function, either as a default export or named `proxy`." Clerk v7.5.2 is
      Next-16-aware (`isNext16OrHigher` / `middlewareFileReference` in
      `@clerk/nextjs/dist/.../sdk-versions.js` — it only affects error-message
      wording). No function rename needed; `config.matcher` unchanged.
- [ ] **Re-verify locally** (not just typecheck): unauthed `/dashboard/nulogdash`
      still 307s to the Clerk handshake; each internal-secret route still reaches
      its own `bearerTokenMatches` check (handler 401/503, not an edge 404);
      `/api/council/public` still bypasses `auth.protect()`.
- [x] Doc references updated: `docs/API-ROUTE-AUTH.md`, the header comment in
      `lib/http-auth.ts` (the Edge-runtime rationale is noted as relaxed — the
      pure-JS compare stays), and a rename note at the top of `proxy.ts`.

**Runtime note:** `proxy` defaults to the **Node.js runtime**, where
`middleware` was Edge. `lib/http-auth.ts`'s pure-JS compare still works and is
kept as-is (correct, dependency-free, tested).

---

## 2. ✅ In-dashboard trigger buttons — built per §5

**Built in this session.** Files:

- `lib/nulogdash-trigger.ts` — pure helpers: pipeline→route+secret map, the
  `TriggerResult` type, and the single-use / 2-min-TTL confirm-token store.
- `lib/nulogdash-actions.ts` (`"use server"`, the repo's first) —
  `triggerPipelineRun` (always dry, returns a confirm token) and
  `confirmLivePipelineRun` (always live; needs that token + typed-back name +
  non-prod DB + rate headroom). No `dryRun` flag the client can flip.
- `app/dashboard/nulogdash/pipelines/_components/TriggerControls.tsx`
  (`"use client"`) — button, pending state, type-to-confirm, result line. No
  fetch / auth / secrets.
- `app/dashboard/nulogdash/pipelines/page.tsx` renders it per card only when
  `canPerformAdminAction(user)` — which is now a live caller of that gate.
- Attribution: the three pipeline routes take an optional `session` body field
  (`followed-tickers` already did); the action passes `nulogdash:<email>`.
- `__tests__/nulogdash-actions.test.ts` — 10 cases (non-admin, no-MFA, bad
  pipeline, dry-run wiring, missing/wrong token, prod-DB refusal, rate limit,
  token burn).

Verified: `npm run build` green; `npm run lint`; the action test suite. Live
end-to-end (an MFA admin firing a real dry/live run) still needs a human — it
requires MFA enrolment and, for the prod-DB refusal, `PRODUCTION_DB_HOST` set
(§3 / manual-setup-todo §9).

---

## 3. 🟠 `--no-dry-run` locally can write through a shared `DATABASE_URL`

**Code side done. Blocked on: a human setting `PRODUCTION_DB_HOST`.**

`.env.local`'s `DATABASE_URL` is one connection string. A local
`--no-dry-run` run writes real rows through whatever branch it names. Nothing
in the tooling distinguished a dev branch from production.

- [x] Structural guard shipped. `lib/pipeline-db-guard.ts`
      (`assertNotProductionDb`) and an inline mirror in
      `scripts/local-trigger.mjs` refuse a live run when `DATABASE_URL`
      resolves to the host in `PRODUCTION_DB_HOST`. Opt-in: inert (warns once)
      until that env var is set. Tests: `__tests__/pipeline-db-guard.test.ts`.
- [ ] **Human:** confirm the local string points at a **dev** Neon branch, and
      set `PRODUCTION_DB_HOST` to the production branch host in `.env.local`
      and in the Vercel project env. Tracked in
      [manual-setup-todo.md](manual-setup-todo.md). Until it is set the guard
      allows everything — the safety property is not active yet.

---

## 4. 🟡 Smaller gaps in what is already built

- [x] **Link a run row to its on-disk HTML report.** Resolved as: the
      DB-rendered detail page is the **canonical** view. The `[id]` page now
      *also* shows the deterministic `docs/pipeline-runs/<ts>-<pipeline>.html`
      path (as an `open …` hint, not a link — browsers block `file://` from an
      http page) when that file exists locally; the block is `NODE_ENV`-guarded
      so a deploy, where the folder never exists, shows nothing.
- [x] **`docs/pipeline-runs/` is gitignored** — kept that way. Generated
      HTML+JSON, two files per run; `pipeline_run_log` is the durable copy and
      the console renders from it. Decision recorded, not a pending task.
- [x] **MFA banner narrowed.** `MfaNotice` now reads "actions that spend model
      quota or write rows (triggering a pipeline run)" — accurate once §2
      ships, and `page.test.tsx` asserts the new copy.
- [x] **Pagination.** `/dashboard/nulogdash/pipelines` takes `?limit=` (50
      default) into the already-clamped `listPipelineRuns` (1–200), with a
      50 · 100 · 200 size row. Still no cursor paging — unnecessary under a few
      hundred rows.
- [ ] **`followed-tickers-select` and `hydrate-universe`** write no run-log row,
      so they are invisible here. **Deferred, not declined:** widening
      `PipelineName` also widens what the §2 buttons can fire, so it should be a
      deliberate follow-up after the trigger UI has proven safe, not folded in
      now.

---

## 5. The secure build — IMPLEMENTED (§2)

Every item below was built. This section is kept as the rationale for *why*
each control exists; §2 lists the files. Quick map: 5.1 Server Action + loopback
fetch → `lib/nulogdash-actions.ts` `callPipelineRoute`; 5.2 re-auth →
`requireAdmin`; 5.3 fail-closed dryRun → there is no client `dryRun` at all, the
two actions are dry-only and live-only; 5.4 second confirmation → the
`mintConfirmToken` / `consumeConfirmToken` dance + typed-name check; 5.5
rate-limit → `rateLimit("pipeline-live:<uid>:<pipeline>", 1, 5m)`; 5.6
attribution → `session: "nulogdash:<email>"` into the run-log row; 5.7 prod-DB
guard → `assertNotProductionDb` (§3); 5.8 minimal island → `TriggerControls.tsx`.

Ordered as a checklist. The safety property to preserve, stated once:

> **The browser must never be able to do something the CLI would have refused.**
> The CLI defaults to `dry_run: true` and refuses `--no-dry-run` without
> `--yes`. The browser needs an equivalent for both halves, and it cannot rely
> on the client to enforce either.

### 5.1 Server Actions, not a client `fetch` to the pipeline route

- [x] The mutations are **Next.js Server Actions** (`lib/nulogdash-actions.ts`),
      not a client `fetch()` to `/api/pipeline/*`. The action attaches the
      bearer secret and loopback-POSTs the route server-side.

Why this is the security-relevant choice: the pipeline routes authenticate with
`Authorization: Bearer $CRON_SECRET` / `$PORTAL_PUSH_SECRET`. For a browser to
call them directly, that secret would have to reach the browser — which ends
the discussion. A Server Action runs on the server, so it can call the pipeline
logic (or the route, loopback, with the secret) while the secret never crosses
the network boundary. Server Actions also carry Next's built-in CSRF origin
check, which a hand-rolled `POST` endpoint would have to reproduce.

### 5.2 Re-authorize inside the action — every time

- [x] Both actions start with `await auth()` → `currentUser()` →
      **`canPerformAdminAction(user)`** (`requireAdmin` in
      `lib/nulogdash-actions.ts`) — not `isNulogdashAdmin`.

`canPerformAdminAction` additionally requires `twoFactorEnabled`. That is the
whole point of it being a separate function: an env-var email allowlist is one
string comparison from full admin, acceptable for reading a report and not for
spending money.

- [x] Nothing the client sends about identity or permission is trusted — both
      are re-derived from the session. **The client payload carries no
      outcome selector at all:** `triggerPipelineRun` takes `{ pipeline }` and
      is *always* a dry run; `confirmLivePipelineRun` takes
      `{ pipeline, confirmToken, typedName }` and is *always* a live run.
- [x] `pipeline` is validated against a fixed set (`isTriggerablePipeline`,
      mirroring the `PipelineName` union) before anything fires.

### 5.3 Live runs fail closed — by having no client switch to flip

- [x] There is no `dryRun` boolean in either payload. The only route to a live
      run is `confirmLivePipelineRun`, which requires the token minted by a
      prior successful dry run (§5.4). "Missing/`"false"`-string/malformed
      `dryRun` → dry run" is satisfied trivially: the dry-run action ignores
      everything except `pipeline`.

### 5.4 A real second confirmation, server-verified

- [x] `--no-dry-run --yes` is mirrored as **two action calls**, not a
      `window.confirm`. A live run needs a short-lived (2 min), single-use
      token that `triggerPipelineRun` minted server-side for that exact
      `{ pipeline, userId }` (`mintConfirmToken`/`consumeConfirmToken` in
      `lib/nulogdash-trigger.ts`), **plus** `typedName === pipeline`.

Concretely: a live run needs a second action call carrying a short-lived,
single-use token the first call minted server-side for that exact
`{ pipeline, userId }`. Typing the pipeline name to confirm is a reasonable
extra friction on top; it is not a substitute.

### 5.5 Rate-limit the action

- [x] `rateLimit()` from `lib/rate-limit.ts`, keyed
      `pipeline-live:<userId>:<pipeline>`, 1 live run per pipeline per 5
      minutes.

Note its documented limit: in-process, per-instance, best-effort on serverless.
That is enough to stop a double-click storm; it is **not** a hard quota. If a
hard cap matters, that is the Redis/Upstash conversation the module's header
already flags.

### 5.6 Attribute the run

- [x] The action passes `session: "nulogdash:<primaryEmail(user)>"` to the
      route, landing on the `pipeline_run_log` row. `followed-tickers-judge`
      and `precompute-ai` gained an optional `session` body field for this;
      `followed-tickers` already had one. "Who fired this live run" is
      answerable from the table the console renders.

### 5.7 Guard the destination before the button exists

- [x] §3's dev-branch check is now enforced **in code**
      (`lib/pipeline-db-guard.ts` `assertNotProductionDb`). Unit 4's live path
      calls it before firing. Still requires a human to set `PRODUCTION_DB_HOST`
      for the check to bite — see §3 and `manual-setup-todo.md`.

### 5.8 Keep the client island minimal

- [x] `app/dashboard/nulogdash/pipelines/_components/TriggerControls.tsx` — a
      button, a `useTransition` pending state, the type-to-confirm step, an
      error line. No data fetching, no auth logic, no secrets. Everything that
      decides anything is in the Server Action.

---

## 6. Lightweight React app vs. built into the existing app

**Recommendation: build into the existing Next.js app.** Not for effort
reasons — for security ones.

A separate lightweight React SPA (Vite + React, its own origin, talking to the
portal's API) would have to **re-implement four properties this app already
has**, and each re-implementation is a place to get it wrong:

| Property | In-app today | In a separate SPA |
|---|---|---|
| Session auth | Clerk cookie + `auth.protect()` at the edge, `auth()` in the page | Needs its own Clerk app or a token-passing scheme across origins |
| Secret handling | `CRON_SECRET` / `PORTAL_PUSH_SECRET` never leave the server | Needs a server shim anyway — or the secret reaches the browser, which is disqualifying |
| CSRF | Server Actions' built-in origin check | Hand-rolled, cross-origin, on a mutation that spends money |
| Admin gate | One `canPerformAdminAction` used by both the page and the action | Duplicated across two codebases, and the API side is the only one that counts |

The SPA also **adds** attack surface — a second origin, a second deploy, a
second set of CORS rules on endpoints that trigger spending — while removing
none. The only thing it buys is independence from the portal's build, which is
not a problem anyone currently has.

What "built in, very securely" means concretely — and note that most of it is
already true:

1. **Server components by default.** Every nulogdash page is one today. Data
   access, the admin gate, and the `pipeline_run_log` queries all stay on the
   server; the browser receives rendered HTML, never a DB handle or a token.
2. **Client islands only where interaction demands it** (§5.8) — a button and
   its pending state, nothing that decides anything.
3. **Mutations are Server Actions**, gated by `canPerformAdminAction`, CSRF-
   checked by the framework, rate-limited, live-only-by-construction (§5).
4. **Defense in depth stays doubled.** `proxy.ts`'s (ex-`middleware.ts`, Next
   16 rename — now Node.js runtime, not Edge) `/dashboard(.*)` matcher blocks
   unauthenticated requests before render; each page *also* calls `auth()` and
   the admin gate. Neither is load-bearing alone — both kept, both verified
   through §1's rename.
5. **Read and write are separate gates.** Reading a report needs
   `isNulogdashAdmin`; anything that mutates needs `canPerformAdminAction`
   (MFA). `lib/nulogdash-actions.ts` is now the first caller of the write-side
   gate.
6. **The console renders no secret and no other user's data.** It shows
   pipeline telemetry. Whatever else lands here later, that boundary is worth
   stating out loud before something gets added that quietly crosses it.

**If the console ever needs to be reachable by someone without a portal
account**, revisit this — that is the one scenario where a separate surface
starts to make sense. It is not the current situation.
