# NWF parallel infrastructure and observable GHA pipeline

**Updated and reviewed:** 2026-10-15.  
**Target:** Preserve the running backend; build a separately named `new-pipeline` slot in the existing billed `ttb-lang1` project with Alpaca market data, OpenRouter analysis, GitHub Actions (GHA) automation, and Google-delivered warnings when operational goals are missed.
**Status:** Phase-1 foundation and a manual cloud credential check are implemented. The owner chose same-project placement on 2026-10-16 after the dedicated project's billing link was rejected by quota. A versioned state bucket was created in `ttb-lang1`, and the 2026-10-17 cloud plan shows 17 creates, 0 changes, and 0 destroys. Terraform has not been applied. A separate shadow Cloud Run Job successfully checked the Alpaca and OpenRouter credentials. No production routes, schedules, or data writers were changed. See [deployment details](../infra/README.md).

> **Placement decision, 2026-10-16:** The earlier dedicated-project design below is historical where it calls for project-level isolation. The current Terraform root is pinned to `ttb-lang1` and creates new resource names, identities, buckets, secrets, and IAM bindings there. Existing `gcp3-backend` resources are outside its state. This removes the billing-project quota blocker but shares project administrators, billing, API enablement, and quotas with the running backend. The sole project API Terraform proposes to enable is STS for GitHub Workload Identity Federation. A separate versioned state bucket and a reviewed zero-destroy plan remain required before apply.

## Implementation status — 2026-10-15

| Work | Result | Evidence / limit |
| --- | --- | --- |
| Dedicated new-slot project | Created, **unbilled** | Billing linkage failed on account project quota; no Terraform apply or workloads there |
| Terraform foundation | Written and locally validated | This NWF PR contains separate identities, image/artifact storage, empty secret containers, and scoped GitHub WIF; [Homebase PR #8](https://github.com/adamaslan/homebase/pull/8) holds the earlier planning copy. `terraform fmt`, init without backend, and validate passed |
| Existing credential connection | Verified in a shadow job | [Portal PR #291](https://github.com/adamaslan/nuwrrrld-portal/pull/291) packages a bounded Alpaca read and OpenRouter key-metadata read; the manual Cloud Run execution completed with `alpaca=ok openrouter=ok` |
| Mobile/web parity record | Updated; headline unchanged | [Mobile PR #58](https://github.com/adamaslan/gcp-expo1/pull/58) records that the cloud preflight adds no client feature or shared-module change |
| Actual new-slot pipeline | Pending | No scheduled ingestion, OpenRouter analysis, durable result ledger, watchdog, Google inbox alert, or production promotion has been implemented |

The working preflight uses a dedicated runner identity and slot-specific Secret Manager references in the **existing billed project**. Its success proves only that those two read-only provider requests worked from GCP. It does not establish project-level isolation, feed-wide coverage, model availability, publication, or alert delivery. The related PRs are drafts awaiting independent cross-model verification.

**Next gate:** independently verify PR #292 and review the saved zero-destroy cloud plan before owner-approved apply. Preserve the shadow job as a manual check until a pipeline worker has a shared Alpaca rate-budget path and the later acceptance drills pass.

## 1. Verification findings and scope

The original draft cited a 2026-09-29 GCP audit, but that audit was not verified. Phase-1 read-only inventory located the live NWF backend and its OpenRouter secret reference; the local FastAPI inventory confirms application entry points, not the existence of every proposed GCP product. Treat the resource map below as a target until reconciled with Terraform state and the remaining cloud inventory.

Read-only inspection of local checkouts found:

| Evidence | Finding | Consequence for the new slot |
| --- | --- | --- |
| `gcp3/.github/workflows/tracker-feed.yml` (sibling repo) | Scheduled feed, manual check-only mode, concurrency protection, Firestore writes, static service-account credential handling, GitHub failure issues | Reuse feed behavior where applicable; migrate new-slot authentication to Workload Identity Federation (WIF), and add Google alerts |
| `../.github/workflows/afternoon-pipeline.yml` | Failure job creates a GitHub issue; email delivery is explicitly deferred | An issue is not evidence that the owner received an email |
| `../.github/workflows/signal-freshness-check.yml` | Independent freshness check defaults to three stale trading days and creates/updates issues | Retain outcome checking; add tighter, job-specific deadlines and a watchdog outside GHA |
| Portal workflows `hydrate-universe.yml`, `paper-portfolios.yml`, `precompute-ai.yml`, `model-usage-report.yml`, and followed-ticker workflows | Existing orchestration surfaces | Map dependencies and reuse contracts before introducing duplicate writers |
| `gcp3/backend/llm/openrouter_client.py`, `gcp3/backend/llm/providers/openrouter.py` (sibling repo) | Existing OpenRouter integration | Extend the established client and measure fallback behavior before creating another client |

These source observations alone do not prove deployed revisions, successful production runs, provider entitlements, or alert delivery. The separate shadow preflight proved two credential checks only. Alpaca's current end-to-end coverage remains unestablished.

Corrections to the original design:

- A slot name is not a Google project ID. Pass `project_id`, region, resource names, and image digest explicitly.
- Declaring resources named `*-current` does not adopt existing production resources. Inventory and import only into a single owning state; require a no-change baseline before migration.
- A shared Firestore database with collection prefixes is not an IAM isolation boundary. Prefer a separate project/database with verified permissions for the new slot.
- Scheduler calls to private Cloud Run require authenticated invocation and invoker IAM. A guessed `/api/refresh` route is not a verified application endpoint.
- `latest-experimental` is mutable. Promote an immutable tested image digest.
- A green workflow does not prove fresh data, complete coverage, valid AI output, or successful downstream publication.

The [original draft](archive/agy-subagent-2026-10-15.before-expansion.md) is archived for traceability.

## 2. Slot architecture and ownership

Use `current` and `new-pipeline` consistently in resource labels, metrics, state prefixes, workflow inputs, artifacts, and result records. Default new-slot execution to shadow mode: no current-slot writes, no live trading, no production traffic changes.

| Component | Target role | Isolation / ownership requirement |
| --- | --- | --- |
| Cloud Run service / Jobs | API plus bounded batch execution | Separate runtime identity and slot resources; Jobs for long batches |
| Firestore | Run ledger, validated outputs, caches | Separate project/database preferred; deny new-slot writes to current data |
| Cloud Scheduler | Independent watchdog; optional primary execution schedule | One primary scheduler per workload; other triggers use the same idempotency contract |
| Pub/Sub | Optional asynchronous dispatch and incident delivery | Slot topics, bounded redelivery, dead-letter handling, idempotent consumers |
| Artifact Registry | Container images | Immutable digests; shared registry owned by a shared state, or separate slot repositories |
| Cloud Storage | Terraform state and pipeline artifacts | Distinct state prefixes, restricted access, versioning and retention; globally unique bucket names |
| Secret Manager | Alpaca/OpenRouter runtime credentials | Slot-specific access grants; Terraform manages references, never plaintext payloads |
| Cloud Logging / Monitoring | Structured outcomes, watchdog metrics, alerts | Slot-filtered policies and dashboards; owner email channel |
| Cloud Build | Optional container builder | Choose GHA build or Cloud Build for each image; avoid duplicate build triggers |
| GHA | Validate, build, dispatch, verify and summarize | Protected environments, least privilege, WIF, explicit slot selection |

```text
infra/
  modules/nwf-app/          # runtime, IAM, storage references, observability
  modules/nwf-monitoring/   # alert policies, channels, independent watchdog
  slots/current/           # existing resources adopted only after reviewed import
  slots/new-pipeline/      # isolated state and resources
  shared/                  # owns shared resources exactly once
config/
  pipeline-goals.yaml      # versioned deadlines, coverage and spend limits
schemas/
  pipeline-result.schema.json
```

The new-slot Terraform root now exists; the other paths remain proposed implementation outputs. It has not been applied, and no current-slot resources were imported. Protect state as sensitive data. Use deletion protection where supported; reject unexpected destroy/replace operations. The current slot must keep operating throughout rollout.

For Scheduler → private Cloud Run, configure `oidc_token.service_account_email`, audience equal to the service URL, and `roles/run.invoker` on the target service. Use an actual implemented route. Cloud Run Jobs invoked through the Google API require the appropriate OAuth/API execution pattern, rather than copying the service OIDC example. See [authenticated Scheduler invocation](https://docs.cloud.google.com/run/docs/triggering/using-scheduler).

## 3. Goals are explicit output contracts

Every scheduled workload declares its expected market session, deadline, eligible universe, minimum coverage, required destinations and budget. The following are **proposed initial defaults**, to tune using shadow-run evidence rather than claims about existing service levels.

| Goal | Warning | Failure / critical condition |
| --- | --- | --- |
| Start on time | No start record 10 minutes after expected start | Still missing at 20 minutes |
| Finish on time | Runtime exceeds 80% of its configured limit | Deadline exceeded, timeout, cancellation, or no terminal result |
| Fresh market data | Near the allowed age for this workload/feed | Beyond configured age, wrong market session, or required symbols stale |
| Universe coverage | At least 95% but less than 99% eligible symbols valid | Less than 95%, or any designated critical symbol missing |
| AI analysis coverage | At least 95% but less than 99% required analyses valid | Less than 95% after bounded fallback attempts |
| Downstream publication | Retry or partial acknowledgement | Required destination lacks read-back proof by deadline |
| Provider reliability | Sustained elevated 429s, fallback use or latency | Authentication/entitlement failure or exhausted retry budget |
| Spend | 80% of configured daily cap | At cap: stop optional paid analysis and report incomplete goals |
| Notification health | Watchdog / alert test overdue | Watchdog heartbeat missing or delivery path fails its test |

A daily-bar job expects the latest completed trading session after its configured settlement margin; an intraday job needs a separate age limit that accommodates feed delays. Use a trading calendar for holidays and early closes, store UTC timestamps, and display ET in owner messages. Weekday cron alone is insufficient. A closed market is `skipped_expected`, with an explanation; unexpected skips are failures.

Require nonempty eligible universes, justified exclusions and both raw and eligible counts. Never improve a coverage percentage by silently dropping failed symbols. Zero trades is not itself a failure: record whether no signals qualified, market gates were closed, risk gates blocked orders, or the execution path broke. Profitability is not guaranteed or inferred from operational success.

Proposed terminal states: `success`, `warning`, `failed`, `skipped_expected`, `cancelled`. Required goal failures must produce a nonzero process exit even when all HTTP requests returned 200. Preserve warning status in GHA summaries and Google notifications.

Each result includes `schema_version`, `slot`, `job`, `run_id`, `run_attempt`, `commit_sha`, `image_digest`, `market_session`, timestamps, deadline, state, goal measurements/thresholds, counts, data source/feed/as-of, model/provider usage, estimated or actual cost, retries, fallback reasons, destination verification, and sanitized diagnostic links. Missing usage is `unknown`, never zero.

## 4. Google communication: failure, warning, recovery

**Default interpretation of “via Google”: Google Cloud Monitoring sends alerts to the owner's chosen Gmail or Google Workspace inbox.** Store that recipient in `ALERT_EMAIL`; do not put an actual address or credential in this document. Google Chat is an optional secondary channel, not assumed configured. Gmail API access is unnecessary for Monitoring's native email notifications.

```text
GHA / Cloud Run → structured outcome + run ledger → goal evaluator
                                                   ↓
Independent Google Scheduler → watchdog → Cloud Monitoring → owner email
                                                   ↓
                                    optional Pub/Sub → Chat adapter
```

The watchdog runs every five minutes outside GHA, reads expected schedules and durable outcomes, and verifies destination freshness independently. It detects workflows that never started, stayed queued, were cancelled, or failed before publishing telemetry. It must not depend on Alpaca/OpenRouter credentials to report an outage. Create metric-based policies for goal breaches and missing watchdog heartbeat, plus log-based alerts for explicit hard errors. Bootstrap heartbeat reporting and test absence detection before relying on it.

Use low-cardinality metric labels (`slot`, `job`, `severity`, `reason_code`). Keep run IDs, symbols and stack traces in logs/ledger, not metric labels. Monitor the watchdog's own failures and permissions. A Google-wide outage can also break Google alert delivery: retain GitHub notifications as a secondary path; Google delivery alone is not an independent outage guarantee.

Every owner notification must answer:

- **What failed?** Job, slot, severity, reason and first occurrence in ET/UTC.
- **Which goal was missed?** Expected value, actual value and deadline.
- **What is affected?** Stale/missing symbols, analysis or downstream surfaces; whether current production is affected.
- **What happened automatically?** Retries, fallback choice, retained last-good data and remaining recovery time.
- **What should I do?** One next action and links to the GHA run, Cloud Logging query, dashboard and runbook.

Example template (illustrative values):

```text
[WARNING][NWF/new-pipeline] EOD analysis coverage below target
Goal: >=99% valid analyses; observed: 97% (970/1000 eligible).
Market session: <session>; deadline: <ET and UTC time>.
Impact: 30 new-slot analyses unavailable; current slot unaffected.
Recovery: provider fallback attempted; one bounded retry remains.
Next action: review provider quota if the retry fails.
Evidence: <GHA run link> | <Cloud Logging link> | <runbook link>
```

Proposed notification policy: immediate critical alert; warning after two consecutive evaluations unless already at a hard deadline; deduplicate by slot/job/reason/session; repeat unresolved criticals after 30 minutes, then every two hours; send one recovery message after two healthy checks. Configure supported Monitoring incident/renotification behavior; implement any per-session grouping and exact reminder cadence not natively supported in the incident adapter. Do not claim these behaviors arise merely from creating an email channel.

Enable recovery notifications explicitly. Maintenance snoozes must expire and must not erase the durable failure record. Require a daily compact digest of goal attainment, failures, warnings, age, coverage, spend and unresolved actions; this digest needs a separate sender implementation and is not a native arbitrary Monitoring email report.

Before accepting the slot, verify receipt of warning, failure, missing-run and recovery test messages in the actual inbox, including spam filtering. A successful publish to Pub/Sub is not proof of inbox delivery. No test messages are sent as part of this documentation task.

🖱 Dashboard: [Cloud Monitoring alerting](https://console.cloud.google.com/monitoring/alerting) — configure the owner channel, attach it to policies, and inspect test incidents. Expected: the chosen inbox receives each authorized drill with useful diagnostic links. [Notification-channel documentation](https://docs.cloud.google.com/monitoring/support/notification-options) and [incident behavior](https://docs.cloud.google.com/monitoring/alerts/concepts-indepth) describe delivery and timing limitations.

## 5. Alpaca-first data ingestion

Use Alpaca as the primary market-data provider in the new GHA path and Cloud Run workers. Provider credentials use Secret Manager references or scoped GHA secrets; map proposed names `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_DATA_FEED` to the actual client's expected environment variables during implementation.

Design requirements:

- Select the feed explicitly and verify account entitlement with a small preflight. IEX and SIP are not interchangeable coverage; permission failures must alert rather than silently downgrade.
- Batch supported multi-symbol requests and follow every `next_page_token`. Stock bars are ordered by symbol then time, so a first page can omit later symbols. See [historical bars](https://docs.alpaca.markets/us/reference/stockbars).
- Incrementally fetch from the last validated watermark with an overlap for corrections. Upsert by symbol/timeframe/timestamp/feed/adjustment and advance the watermark only after durable validation.
- Record `source=alpaca`, feed, adjustment policy, exchange/event time, retrieval time, session and completeness on each persisted row. Preserve raw and adjusted-series semantics.
- Validate timestamps, duplicates, missing required sessions, numeric ranges and OHLC consistency. Missing data is not zero; non-trading/halted symbols need explicit exclusion reasons.
- Use connection pooling and bounded concurrency. Respect the subscribed plan's limits, honor server retry guidance, and apply exponential backoff with jitter for transient failures. Stop on authentication/entitlement failures; avoid retry multiplication across SDK, worker and GHA.
- Cache immutable historical ranges and refetch only recent correction windows. Cache keys include feed, adjustment, timeframe and range; freshness checks still apply to cached results.
- Keep trading credentials and market-data access separate where available. New-slot order execution stays disabled; paper endpoints require an explicit paper-mode configuration and idempotent order handling.

No automated GHA yfinance fallback: yfinance is local-only. Finnhub must not supply candles or premium sentiment. If Alpaca is unavailable, retain the last validated snapshot with an explicit stale marker, withhold new conclusions requiring fresh data, and send the goal failure through Google. Consult [Alpaca feed and entitlement guidance](https://docs.alpaca.markets/us/docs/market-data-faq).

## 6. OpenRouter analysis and cost optimization

Extend the existing OpenRouter client behind one shared interface. Analysis consumes validated market inputs and cannot fabricate prices, freshness, publication success or provider health. The alert evaluator must work without an LLM; AI may add a clearly labeled explanation but cannot suppress or downgrade deterministic incidents.

Use these configurable controls:

| Control | Required behavior |
| --- | --- |
| Model allowlist | Benchmark candidate models on representative NWF fixtures; configure primary and bounded fallback models instead of hardcoding a presumed permanent free model |
| Structured output | Request JSON Schema on compatible models, set `provider.require_parameters=true`, and validate locally; reject malformed, truncated or unsupported responses |
| Provider routing | Enable controlled provider fallbacks; use price ordering for batch work, latency ordering for deadline-sensitive work; verify all fallbacks meet capability/privacy requirements |
| Model fallback | Distinguish same-model provider failover from changing models; record requested/actual model and provider when returned |
| Retry budget | One overall wall-clock/token/cost budget across retries and fallbacks; no unbounded paid escalation |
| Prompt size | Compute indicators deterministically; send compact evidence with timestamps and source IDs instead of entire raw histories |
| Caching | Reuse validated analysis only for identical input digest, model, prompt/schema version and freshness window; provider prompt-cache support must be checked per model |
| Spend | Record usage and reconciled cost; use per-job caps plus an atomic shared daily reservation/ledger so parallel workers cannot each spend the full daily budget |
| Quality | Track valid-output rate, evidence coverage, unsupported claims, fallback rate, latency and cost per accepted analysis |

Use `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_DAILY_BUDGET_USD` and job-specific limits as proposed configuration names. Check available models/capabilities at rollout; unavailable budget or mandatory model configuration is a preflight failure. Never interpret a free-tier endpoint as unlimited or guaranteed capacity.

At budget exhaustion, report `warning` or `failed` according to required-analysis coverage, retain already validated results, and stop optional calls. A fallback answer is acceptable only after the same schema and evidence checks. Record fallback use even when the run ultimately succeeds.

Verified API references: [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks), and [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs). These establish available controls, not measured NWF performance gains.

## 7. Optimized GHA execution contract

Keep CI, image build/deployment and scheduled data execution as distinct workflows. Build once, reuse the tested image digest, and choose runner execution or Cloud Run Jobs per workload. Do not assume a dispatch returning 200/202 means a batch completed; poll the execution and verify persisted outcomes.

Proposed job graph:

```text
preflight → calendar/idempotency gate → Alpaca ingest → validate inputs
          → deterministic signals → OpenRouter analysis → validate outputs
          → publish to new slot → read back destinations → evaluate goals
all terminal paths → sanitize artifacts + GHA summary + Google telemetry
independent watchdog → detect absent or incomplete terminal paths
```

Required workflow properties:

- `workflow_dispatch` exposes validated `slot`, `dry_run`, session and optional bounded ticker scope. Default to `new-pipeline` and dry-run. Scheduled runs use reviewed configuration, not untrusted input interpolation.
- Start with `contents: read`; grant `id-token: write` only to jobs needing WIF. Scope federation to the intended repository and trusted branch/environment. Avoid long-lived service-account JSON. Keep deployment, runtime and observer identities separate. See [Google's GHA authentication action](https://github.com/google-github-actions/auth).
- Pin third-party actions to reviewed full commit SHAs. Use a locked mamba environment for Python installation and execution; never install Python dependencies outside that environment. Cache dependencies by OS/runtime/lock hash, never credentials or generated authentication files.
- Use concurrency groups scoped to slot/workload, with `cancel-in-progress: false` for writers. GHA concurrency is not a durable queue and does not coordinate separate repos: use a transactional lease/idempotency key `(slot, job, market_session, input_version)` at the write boundary.
- Set job, step, HTTP and batch deadlines. Bound matrix parallelism to provider quotas; keep any retry inside the same total execution budget. For useful partial results, let shards finish and aggregate all outcomes before deciding success.
- Preserve nonzero failures; do not mask required errors with `continue-on-error`, `|| true`, or catch-and-success handlers. Parse application-level response statuses, not only HTTP status.
- Run a bounded finalizer with `if: ${{ always() }}` and explicit dependencies on all jobs. Include `needs.*.result` for skipped, failed and cancelled paths. An always-condition is best effort, not a guarantee after runner loss/cancellation; the independent watchdog is mandatory.
- Write a concise `$GITHUB_STEP_SUMMARY`, workflow warning/error annotations, and a sanitized result artifact using an explicit file allowlist. Never upload `/tmp/*.json` indiscriminately; it may include credentials or private responses. Proposed diagnostic retention: 14 days.
- Separate operational health from notification health. If publishing telemetry fails, keep the primary failure visible, annotate the notification failure, and let the watchdog detect the absent outcome.
- Run secret-free CI for untrusted pull requests. Provider access, runtime writes and deployment only occur in trusted contexts with scoped credentials. Respect existing cross-model PR verification rules.

GHA schedules may be delayed or dropped under load and execute from the default branch; do not infer punctuality from cron configuration. Use off-hour-minute schedules where practical and validate the repository's timezone configuration against current GitHub support. The inspected local cron expressions are UTC-based and need ET/DST and trading-calendar handling. See [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

## 8. Acceptance and promotion gates

The following are required test scenarios for the implementation; none were executed against cloud services during this document review.

| Drill | Expected observable result |
| --- | --- |
| Alpaca timeout / rate limit | Bounded retries; stale output withheld; owner warning/failure with source and age |
| Alpaca permission denial | No retry storm or silent feed downgrade; actionable credential/entitlement alert |
| Missing second bars page | Coverage validation fails; incomplete output cannot count as success |
| Invalid OpenRouter JSON / unavailable model | Bounded compatible fallback, local validation, actual model recorded |
| OpenRouter budget exhausted | Paid work stops; spend and missing coverage reported honestly |
| GHA never starts / is cancelled | Independent watchdog alerts after configured deadline |
| Workflow exits zero with stale results | Outcome evaluator fails the job and Google alert fires |
| Downstream write rejected | Read-back gate fails; last-good output remains identifiable |
| Telemetry transport unavailable | Failure remains in GHA; watchdog detects absent terminal state |
| Warning resolves | One recovery notice with duration and restored measurements |
| Duplicate dispatch / retry | One logical publication; no duplicate paper orders or spend reservation |
| Holiday / early close | Expected skip or adjusted deadline, without false stale-data alarms |
| Isolation probe | New identity cannot write current-slot stores or invoke unauthorized production writers |

Promotion requires at least five consecutive trading sessions meeting required goals, successful notification drills, no cross-slot writes, reviewed cost/latency evidence, and a tested rollback. Compare both slots on the same input snapshots to avoid market movement confounding results. Do not promote merely because the new container starts.

Adopting current resources, enabling production writes, changing traffic, switching schedules, and live trading are separate operations requiring owner approval under project rules. This documentation update authorizes none of them. Rollback restores the previously recorded image/routing and writer ownership; it does not destroy the new slot, erase logs or rewind data blindly. Only one slot owns production publication at a time.

## 9. Read-only validation commands

These commands inspect local portal source without loading `.env` or running production pipelines.

```bash
cd /path/to/nuwrrrld-portal
rg -n 'schedule:|workflow_dispatch:|concurrency:|notify:|timeout-minutes:' \
  .github/workflows
# Expected: existing workflow trigger, timeout, concurrency and notification locations.
```

```bash
cd /path/to/nuwrrrld-portal
rg -n 'OpenRouter|Google|Alpaca|watchdog|budget|Status:' docs/nwf-new-slot-terraform.md
# Expected: all integration contracts and the implementation-only status appear.
```

The infrastructure root now exists. From the portal root, check its formatting:

```bash
terraform fmt -check -recursive infra
# Expected: exit 0, with no formatting differences.
```

`terraform init -backend=false` and `terraform validate` have also passed locally with the committed provider lockfile. A real plan still requires an eligible billed project, a pre-existing versioned state bucket, backend configuration, and populated variables. The [deployment README](../infra/README.md) gives the exact plan commands. Review the saved plan for unexpected deletion/replacement, IAM scope, project identity, and secrets before apply.

## 10. Still unverified before implementation

The original GCP audit and full live inventory; current Terraform ownership; actual alert recipient and inbox delivery; Alpaca plan/feed quotas; OpenRouter model availability and account budgets; GCP APIs/IAM beyond the preflight; exact application routes and downstream schemas; existing deployed workflow versions; and production write permissions remain unverified. Billing for the new project is **verified blocked by account project quota**. Resolve the remaining items during implementation with read-only inventory first. Record evidence without storing credentials, real project IDs, database URLs or Cloud Run hostnames in this document.
