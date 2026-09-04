# Pipeline route status — open issues

Probed 2026-09-03 while verifying `scripts/local-trigger.mjs` (PR #99) against
production. Each `/api/pipeline/*` route was hit with an **unauthenticated**
`POST {}` on `https://financial.nuwrrrld.com` and cross-referenced against
`app/api/pipeline/*/route.ts` in the repo.

| Route | In repo | Prod (unauth POST) | Reading |
|---|---|---|---|
| `signals-refresh` | ❌ | **404** | not written, not deployed |
| `theses-score` | ❌ | **404** | not written, not deployed |
| `council-run` | ❌ | **404** | not written, not deployed |
| `council-validate-distribution` | ❌ | **404** | not written, not deployed |
| `followed-tickers` | ✅ | **503** | deployed, but failing before/at a dependency |
| `followed-tickers-select` | ✅ | **503** | deployed, but failing before/at a dependency |
| `followed-tickers-judge` | ✅ | **503** | deployed, but failing before/at a dependency |
| `precompute-ai` | ✅ | **401** | deployed; auth gate responded as expected — rejects a missing bearer token (authenticated execution + downstream deps unverified) |
| `hydrate-universe` | ✅ | **401** | deployed; auth gate responded as expected — rejects a missing bearer token (authenticated execution + downstream deps unverified) |

A 404 here is *by design loud*: the routes were namespaced under `/api/pipeline/*`
(a path with no prior occupant) so a missing route fails visibly instead of
silently 401ing against an unrelated working endpoint. See
`docs/wiki-portal/decision-afternoon-pipeline-cron-split.md`.

---

## Issue 1 — `afternoon-pipeline.yml` has no routes to call (P1)

**Status:** open since 2026-08-14 (PR #59). The workflow ships the orchestration
+ failure-notification path *ahead of* the 4 routes it calls. All 4 are still
absent from the repo and return 404 in production:

- `POST /api/pipeline/signals-refresh`
- `POST /api/pipeline/theses-score`
- `POST /api/pipeline/council-run`
- `POST /api/pipeline/council-validate-distribution`

**Effect:** every scheduled `afternoon-pipeline` run that clears the market-hours
gate fails at the first curl. The last such run was #32891544974 (2026-08-25) —
it failed earlier still, at the secret-preflight step, because `CRON_SECRET` /
`PORTAL_URL` are unprovisioned (Issue 3). Runs since then have all gate-skipped,
so the 404 hasn't even been reached again.

**Fix path:** land the 4 handlers. This is tracked as "a separate, larger unit
of work" in the zo-migration status doc under `homebase/docs/`; the wiki
decision explicitly rejected holding the CI/scheduler infra until they exist.
Until then, either:

- disable the workflow (`gh workflow disable afternoon-pipeline.yml`) so it stops
  filing `pipeline-failure` issues, **or**
- accept the noise and leave it enabled as a visible reminder.

`council-validate-distribution` additionally has **no `dry_run` contract** — it
takes no such parameter. `local-trigger.mjs` now marks it `requiresConfirm` and
refuses to send it on Path C without `--no-dry-run --yes` (PR #99).

---

## Issue 2 — `followed-tickers*` routes 503 before auth (P2, new)

`followed-tickers`, `followed-tickers-select`, and `followed-tickers-judge` are
deployed (they're in the repo and don't 404) but return **HTTP 503** to an
unauthenticated `POST {}` — i.e. *before* a 401 for the missing bearer token.

A 503 ahead of the auth check means the handler is throwing on a missing
dependency, a `feature-not-ready` guard, or an unconfigured upstream — not a
routing problem. The two sibling routes that *do* behave (`precompute-ai`,
`hydrate-universe` → 401) confirm the auth middleware itself is fine.

**Next step:** read the three `route.ts` files and Vercel runtime logs for one
request; identify what returns 503. Likely candidates: a `SIGNALS_ENGINE_URL` /
`MCP_BACKEND_URL` health check, a missing table, or an explicit
"cohort not selected yet" 503 (the monthly `select-followed-tickers` job that
freezes the cohort has also never completed).

---

## Issue 3 — `CRON_SECRET` unprovisioned everywhere (P1, blocks 1 & local testing)

`CRON_SECRET` is:

- **not** a GitHub Actions repo secret → `afternoon-pipeline.yml` fails its
  secret-preflight step (already in `docs/manual-setup-todo.md` §1);
- **not** in `.env.local` → `local-trigger.mjs C <caller>` and any manual `curl`
  can't authenticate. Only `PORTAL_PUSH_SECRET` is present locally, and it is a
  *distinct, non-interchangeable* secret (different callers, different routes).
- present only in `.env.example` as a placeholder name.

**Fix:** `openssl rand -hex 32` once; put the same value in `.env.local`, Vercel
project env, and `gh secret set CRON_SECRET`. It must match what every caller
sends (GHA workflows + `setup-schedulers.sh` GCP jobs).

---

## Issue 4 — `pipeline-failure` label missing (P3)

The `notify` job in every scheduled pipeline workflow does
`gh issue create --label pipeline-failure`. That label doesn't exist in the
repo, so the notify job itself fails:

```text
could not add label: 'pipeline-failure' not found
```

**Fix:** `gh label create pipeline-failure --color B60205 --description "Scheduled pipeline run failed"`.
One command. Until then a pipeline failure produces *two* red jobs and no issue.

---

## What the wiki already says (checked 2026-09-03)

- **`decision-afternoon-pipeline-cron-split.md`** — the canonical record. The 4
  routes "do not exist yet"; workflow is "merged but non-functional until the 4
  trigger routes ship"; routes deliberately namespaced under `/api/pipeline/*`
  so the 404 is loud; landing them is a separate larger unit of work. No fix has
  been scheduled since.
- **`decision-precompute-ai-at-quota-reset.md` / `entity-ticker-universe-pipeline.md`**
  — `precompute-ai` and `hydrate-universe` were themselves untracked-in-git and
  404ing in production "until PR #66 merges/deploys." Today's probe confirms
  **that shipped**: both now 401 (deployed; auth gate responding as expected). So the pattern *has* been worked
  before — these two are the template for closing Issue 1.
- No wiki page covers the `followed-tickers*` 503 (Issue 2) — it's new here.

## See also

- `docs/manual-setup-todo.md` §0/§1 — the secret side of Issue 3
- `docs/pipeline-todo-blockers.md` — the pre-existing blocker list this extends
- `docs/wiki-portal/decision-afternoon-pipeline-cron-split.md` — Issue 1's origin
- `docs/github-actions-deployment-and-local-triggering.md` — how to trigger/probe each path
