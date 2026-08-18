# Zo Ideas as a More Efficient NuWrrrld Pipeline

Written 2026-08-18.

This synthesizes `docs/Recent Docs/how-i-use-zo.md`,
`docs/max-coverage-simplest-path.md`,
`docs/gha-modal-core-feature-coverage.md`, and
`docs/wiki-portal/decision-afternoon-pipeline-cron-split.md`.

The question: should the ten free-tier pipeline ideas in the Zo snapshot be
folded into the current portal architecture, or do they imply a brand new Daily
Engine?

Short answer: **fold them in as host roles, not as ten alternative rebuilds.**
The efficient pipeline is not "move Zo to GitHub Actions" or "move everything
to Cloudflare." It is:

- GitHub Actions as the loud control plane, auditor, PR opener, and artifact
  reporter.
- GCP Cloud Scheduler as the precise market-clock trigger.
- Modal as the burst/fan-out compute lane and quota-reset AI spender.
- The portal plus Neon as the source of truth and serving surface.
- Cloudflare as an optional public edge mirror, not the primary data plane.
- Zo as an optional research/creative analyst, not the deterministic scheduler.

That is mostly an incorporation plan. The new thing is not another app; it is a
clean split of responsibilities so silent degradation has nowhere to hide.

---

## What Zo Taught Us

The Zo failures are all the same class of bug wearing different costumes:

| Zo failure | Pipeline requirement | Existing portal primitive |
|---|---|---|
| `GET /api/nwf-digest` has been down, but the briefing kept shipping fallback HOLDs | A fallback must be visible, counted, and eventually fail the run | `e2e-resiliency.yml` preflight/health gates, `afternoon-pipeline.yml` hard curl status checks, distribution validation |
| `secrets/zo_hydrate_secret.txt` is missing, so enrichment self-skips | Missing secrets must be configuration errors, not no-ops | `PORTAL_PUSH_SECRET`/`CRON_SECRET` bearer routes return `CONFIG_ERROR` when unset |
| `/root/.free-model-env` has empty tokens, so model refresh never works | One owner per credentialed automation; duplicate automations rot | `.github/workflows/refresh-free-models.yml` already owns `FREE_MODEL_CHAIN` refresh |
| Public copy says one schedule, Zo runs another, skills say a third | Schedules need a registry and a single truth per clock | `decision-afternoon-pipeline-cron-split.md` already assigns clocks by host |

So the improvement is not just free compute. It is **free compute with failure
visibility**. A red GitHub check, a Modal exception, or a Cloud Scheduler
delivery failure is much healthier than a green email built from degraded input.

---

## The Better Architecture

The pipeline should have four data products:

1. **`ticker_cards`**: full-universe, deterministic signal cards from
   `toStateKeyParts()`/`toStateKey()`, scored in code, no model quota.
2. **`precomputed_ai`**: small, schema-validated AI artifacts for things a human
   will read: top-N explanations, portfolio health prose, daily briefing
   narrative.
3. **`public/backend-status.json` or an equivalent table**: scheduled liveness
   results the app can use as a circuit-breaker input.
4. **A published briefing artifact**: first pass can be
   `precomputed_ai(kind='daily_briefing', subject='YYYY-MM-DD:main')`; only
   add a dedicated `briefing_artifacts` table when archive queries become a real
   product feature.

The host split:

```text
GCP Cloud Scheduler
  -> precise market-clock POSTs to portal pipeline routes

GitHub Actions
  -> audits, PRs, preflight, liveness, issue creation, workflow summaries

Modal
  -> per-ticker fan-out, pandas/batch work, quota-reset AI precompute

Portal / Neon
  -> source of truth, auth boundary, reads, writes, public API responses

Zo
  -> optional analyst layer for web/X/image research, never silent core data
```

This keeps the useful Zo idea: the Daily Engine is a composed briefing, not just
a database job. But it removes the part that hurt: a single agent runner that
can fall back, skip, or drift without any external witness.

---

## Where The Ten Free-Tier Options Land

The ten options in `how-i-use-zo.md` are useful, but not as ten equal choices.
They are a menu of primitives.

| Option | Keep? | Role in this repo |
|---|---:|---|
| GitHub Actions | Yes | Control plane, liveness, issue/PR automation, non-time-critical daily or weekly jobs |
| Modal | Yes | Fan-out compute, quota-reset AI precompute, warm scheduled work |
| GCP always-free | Yes | Precise market-clock triggers and existing `gcp3` repair path |
| Cloudflare Workers/Pages/KV | Maybe | Public edge mirror for status/briefing JSON; not the heavy indicator engine |
| Vercel/Netlify | Maybe | Existing frontend host and occasional once-daily cron; not the main scheduler |
| Supabase + pg_cron | No, unless starting over | Good shape, but Neon already exists; swapping databases adds churn |
| AWS | No | Technically viable, but adds a third cloud with no special advantage here |
| Azure | No | Same as AWS: viable, not simpler than the existing GCP/GHA/Modal split |
| Oracle VM | No | Powerful free VM, but it recreates the "pet cron box" failure mode Zo exposed |
| Val Town / Deno Deploy | Prototype only | Excellent for tiny proofs; too much new surface for the production pipeline |

The important demotion is Oracle. A free VM is tempting because it can run the
old pipeline almost unchanged, but "a Linux box with cron" is exactly the shape
that lets credentials go empty and fallback logs go unread.

Cloudflare is the interesting optional add: it is not where the market-data
math should run, but it is a good place to serve a tiny public JSON artifact or
status file from the edge if `financial.nuwrrrld.com` ever needs to decouple
from the app host.

---

## The Daily Flow

This flow assumes the signal-card plan from
`docs/max-coverage-simplest-path.md` exists.

### Weekly

- GitHub Actions refreshes `FREE_MODEL_CHAIN`, with vendor diversity and seat
  model validation.
- GitHub Actions or GCP refreshes `ticker_universe`.
- The grounding compiler updates `grounding_pack` after taxonomy or corpus
  changes.
- A scheduled liveness/audit job opens or updates one tracking issue if backend
  routes, model IDs, or documented routes have drifted.

### Nightly / Post-Close

- Modal or GCP computes per-stock indicators in batches.
- The portal hydrates `ticker_cards` through
  `POST /api/pipeline/hydrate-universe`.
- SQL ranks cards by deterministic score and data quality.
- `POST /api/pipeline/precompute-ai` spends a bounded number of model calls on
  the ranked top N and stores explanations in `precomputed_ai`.

### Market Clock

GCP Cloud Scheduler owns the precise market-clock jobs because GitHub Actions
scheduled workflows can be delayed or dropped under load.

- 10:15 AM ET: open check / hot-set refresh.
- 12:15 PM ET: main briefing compile.
- 4:30 PM ET: post-close scorer.

GitHub Actions can still own the 3:15 PM ET pre-close run because that workflow
already has a buffer, manual `workflow_dispatch`, summaries, and issue creation.
It is a control-plane run, not a bell-ringing clock.

### Publish And Deliver

- The portal writes the daily briefing artifact.
- The public page reads that artifact, not Zo's local filesystem.
- Email/Telegram delivery sends the same artifact ID the site serves.
- Zo can add a research supplement only if it writes a structured
  `zo_enrichment` block with `source`, `asOf`, `fallbackUsed`, and `confidence`;
  it cannot silently replace the deterministic numbers.

---

## Contracts That Prevent Another Silent Month

1. **Fallback is data.** Any fallback path must set `fallbackUsed: true`,
   `fallbackReason`, `source`, and `asOf`. After one trading day of fallback,
   the job should warn. After two, it should fail or open an issue.
2. **Uniform HOLD is suspicious.** A distribution check should hard-fail the
   run when every actionable ticker collapses to HOLD unless the source data
   explicitly says the market is closed or no indicators are available.
3. **Missing secrets are 503s.** Scheduled endpoints should return
   `CONFIG_ERROR`, not skip internally.
4. **One scheduler per endpoint.** GHA and Modal versions can both exist, but
   exactly one should be enabled for any quota-spending route.
5. **Artifacts are immutable by ID.** Re-running a session writes a new
   `run_id` or replaces only the same idempotency key, so delivery, archive,
   and public page agree on what was sent.
6. **Human-readable status is part of the product.** A job summary, status JSON,
   or issue should say what data source was used and whether the run degraded.

These rules are stricter than "make the pipeline work." They are designed to
make the next breakage noisy within minutes, not discoverable a month later.

---

## Minimal Build Order

1. **Retire the duplicate Zo model-refresh automation.** Keep
   `.github/workflows/refresh-free-models.yml` as the only owner of
   `FREE_MODEL_CHAIN`; add `SEAT_MODELS` validation there.
2. **Add scheduled backend liveness.** Probe `gcp3` digest/signals routes and
   write status to a file or table the app can read. Open/update one issue on
   sustained failure.
3. **Make the Daily Engine publish through the portal.** Store the briefing JSON
   as a portal-owned artifact instead of `site_data/briefing.json` on Zo.
4. **Implement `ticker_cards` and the rules scorer.** This gives full-universe
   ranking and grounding without model quota.
5. **Wire per-stock indicators.** Prefer fixing gcp3 if the existing feature
   modules can be reused cleanly; otherwise Modal pandas is the faster first
   implementation.
6. **Move daily briefing composition onto scheduled portal routes.** The model
   gets ranked token cards and macro inputs, writes schema-locked output, and
   never fetches or computes.
7. **Keep Zo as an analyst, not a scheduler.** Use it for web/X/image research
   supplements when desired, behind a typed enrichment contract and visible
   provenance.

This is the smallest path that incorporates the Zo ideas without rebuilding the
same reliability problem on a different free host.

---

## Brand New Or Part Of The Current Pipeline?

It is part of the current pipeline.

The database, OpenRouter client, model-refresh workflow, precompute endpoint,
Modal precedent, Playwright preflight posture, and Cloud Scheduler setup all
already exist in this repo. Throwing that away for a clean-room GHA, Cloudflare,
or Oracle version would feel simpler for a week and then become a parallel
system to reconcile.

What should be new is the **Daily Briefing Compiler** boundary:

```text
inputs:
  ticker_cards top-N
  grounding_pack citations
  backend-status
  macro/sentiment facts
  previous-call performance

output:
  one schema-validated daily briefing artifact
  one delivery event that references that artifact
  one status summary that says live/degraded/failed
```

That boundary can run from GCP Scheduler, GHA, or Modal because the endpoint is
the product. The host is just the clock.

---

## Provider Notes Checked 2026-08-18

Free-tier and pricing details change. Treat these as implementation inputs to
verify during build, not permanent architecture facts.

- GitHub Actions is free for public repositories using standard GitHub-hosted
  runners; private repositories use included minutes. Scheduled workflows can
  be delayed under high load and can be dropped if load is high enough.[^github-actions][^github-schedule]
- Modal Starter lists $30/month in free credits and supports scheduled/web
  functions with limits.[^modal-pricing]
- Google Cloud Scheduler gives three jobs per billing account free, while Cloud
  Run has a monthly free tier that depends on region/pricing mode.[^gcp-scheduler][^gcp-run]
- OpenRouter free-model limits are account-tiered; the live key endpoint should
  still be checked before choosing the daily AI batch size.[^openrouter-faq][^openrouter-limits]
- Cloudflare Workers Free has daily request limits; KV has free daily read/write
  and storage limits, which makes it good for small artifacts but awkward for
  heavy fan-out writes.[^cloudflare-workers][^cloudflare-kv]
- Vercel Hobby cron remains useful for daily jobs, but current cron usage docs
  should be checked before relying on frequency or count limits.[^vercel-cron]
- Supabase is a credible all-in-one alternative, with free database and Edge
  Function allowances plus project pausing after inactivity, but replacing Neon
  is not justified by this task.[^supabase-pricing][^supabase-functions]
- AWS and Azure have free serverless allowances, but neither removes a problem
  this repo does not already solve with GCP/GHA/Modal.[^aws-eventbridge][^aws-lambda][^azure-functions]
- Deno Deploy and Val Town are excellent small-prototype hosts; use them to test
  a tiny JSON publisher, not to own production financial state.[^deno-pricing][^val-pricing]
- Oracle Always Free is real VM capacity, but operationally it is closest to the
  failure mode this doc is trying to retire.[^oracle-free]

[^github-actions]: https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions
[^github-schedule]: https://docs.github.com/actions/using-workflows/events-that-trigger-workflows
[^modal-pricing]: https://modal.com/pricing
[^gcp-scheduler]: https://cloud.google.com/scheduler/pricing
[^gcp-run]: https://cloud.google.com/run/pricing
[^openrouter-faq]: https://openrouter.ai/docs/faq
[^openrouter-limits]: https://openrouter.ai/docs/api_reference/limits
[^cloudflare-workers]: https://developers.cloudflare.com/workers/platform/limits/
[^cloudflare-kv]: https://developers.cloudflare.com/kv/platform/limits/
[^vercel-cron]: https://vercel.com/docs/cron-jobs/usage-and-pricing
[^supabase-pricing]: https://supabase.com/pricing
[^supabase-functions]: https://supabase.com/docs/guides/platform/manage-your-usage/edge-function-invocations
[^aws-eventbridge]: https://aws.amazon.com/eventbridge/pricing/
[^aws-lambda]: https://aws.amazon.com/lambda/pricing/
[^azure-functions]: https://azure.microsoft.com/en-us/pricing/details/functions/
[^deno-pricing]: https://deno.com/deploy/pricing
[^val-pricing]: https://www.val.town/pricing
[^oracle-free]: https://docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
