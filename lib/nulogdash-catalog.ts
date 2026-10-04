/**
 * nulogdash-catalog — the static inventory of scheduled work behind the
 * pipelines console: every GitHub Actions workflow and every Modal app, with
 * its triggers and sub-features (jobs / functions).
 *
 * Presentation-adjacent data kept in code rather than the DB: a workflow's
 * schedule lives in its YAML and a Modal app's in its decorator, so the
 * catalog is the single place the console reads them from. The drift test
 * (__tests__/nulogdash-catalog.test.ts) fails if a workflow file is added or
 * removed without a matching entry here.
 *
 * `pipeline` links an entry to the `pipeline_run_log` rows it writes, so the
 * console can show real run evidence instead of only the schedule.
 */
import type { PipelineName } from "@/lib/pipeline-run-log-db";

export interface CatalogSubFeature {
  label: string;
  /** One line on what it does. Shown as-is; keep it factual. */
  detail: string;
}

export interface CatalogEntry {
  /** Workflow file basename (GHA) or Modal app name. Stable key. */
  id: string;
  label: string;
  /** Repo-relative path to the definition. */
  source: string;
  /** Human-readable trigger, e.g. "Cron 20:30 UTC, Mon–Fri". */
  trigger: string;
  /** Whether a human can fire it (workflow_dispatch / modal run). */
  manual: boolean;
  /** Set when the run writes a pipeline_run_log row. */
  pipeline?: PipelineName;
  subFeatures: CatalogSubFeature[];
}

const GITHUB_WORKFLOWS: CatalogEntry[] = [
  {
    id: "track-followed-tickers.yml",
    label: "Track followed tickers (daily)",
    source: ".github/workflows/track-followed-tickers.yml",
    trigger: "Cron 19:30 & 20:30 UTC, Mon–Fri · manual",
    manual: true,
    pipeline: "followed-tickers",
    subFeatures: [
      { label: "gate", detail: "Verifies secrets and the trading-day check before any model call." },
      { label: "track", detail: "Runs the followed-ticker tracking pass (dry-run supported)." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "judge-followed-tickers.yml",
    label: "Judge followed tickers (weekly)",
    source: ".github/workflows/judge-followed-tickers.yml",
    trigger: "Cron Sat 16:00 UTC · manual (dry-run supported)",
    manual: true,
    pipeline: "followed-tickers-judge",
    subFeatures: [
      { label: "judge", detail: "Grades the week's followed-ticker calls against outcomes." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "select-followed-tickers.yml",
    label: "Select followed tickers (monthly cohort)",
    source: ".github/workflows/select-followed-tickers.yml",
    trigger: "Cron 1st of month 14:00 UTC · manual",
    manual: true,
    subFeatures: [
      { label: "gate", detail: "Verifies secrets before any call." },
      { label: "select", detail: "Picks the monthly followed-ticker cohort." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "precompute-ai.yml",
    label: "Nightly AI precompute",
    source: ".github/workflows/precompute-ai.yml",
    trigger: "Cron 00:10 UTC daily · manual",
    manual: true,
    pipeline: "precompute-ai",
    subFeatures: [
      { label: "precompute", detail: "Pre-generates AI reads for the watchlist so pages render without a live model call." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "paper-portfolios.yml",
    label: "Council paper portfolios (4x daily)",
    source: ".github/workflows/paper-portfolios.yml",
    trigger: "Four slots, Mon–Fri (EST/EDT pairs) · manual",
    manual: true,
    subFeatures: [
      { label: "gate", detail: "Confirms the trading day and secrets before any fill." },
      { label: "run-slot", detail: "Runs one slot (preopen, midday, preclose, settle) for all eight accounts." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "afternoon-pipeline.yml",
    label: "Afternoon pre-close pipeline",
    source: ".github/workflows/afternoon-pipeline.yml",
    trigger: "Cron 19:15 & 20:15 UTC, Mon–Fri · manual",
    manual: true,
    subFeatures: [
      { label: "gate", detail: "Verifies the trading day before running." },
      { label: "pipeline", detail: "Runs the afternoon pre-close pass." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "hydrate-universe.yml",
    label: "Nightly universe hydration",
    source: ".github/workflows/hydrate-universe.yml",
    trigger: "Cron 22:30 UTC, Mon–Fri · manual",
    manual: true,
    subFeatures: [
      { label: "hydrate", detail: "Refreshes end-of-day indicators for the ticker universe." },
    ],
  },
  {
    id: "engine-nightly.yml",
    label: "Engine nightly",
    source: ".github/workflows/engine-nightly.yml",
    trigger: "After Nightly universe hydration completes · manual",
    manual: true,
    subFeatures: [
      { label: "engine", detail: "Runs the signal engine and writes only engine_* tables." },
    ],
  },
  {
    id: "refresh-free-models.yml",
    label: "Refresh free model chain",
    source: ".github/workflows/refresh-free-models.yml",
    trigger: "Cron Mon 06:17 UTC · manual",
    manual: true,
    subFeatures: [
      { label: "refresh", detail: "Rebuilds the FREE_MODEL_CHAIN from currently available free models." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "compile-grounding-pack.yml",
    label: "Compile grounding pack",
    source: ".github/workflows/compile-grounding-pack.yml",
    trigger: "Cron 06:23 UTC · manual",
    manual: true,
    subFeatures: [
      { label: "compile", detail: "Builds the grounding pack used by AI reads." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "sync-corpus.yml",
    label: "Sync grounding corpus",
    source: ".github/workflows/sync-corpus.yml",
    trigger: "Cron Mon 05:41 UTC · manual",
    manual: true,
    subFeatures: [
      { label: "sync", detail: "Syncs the grounding corpus." },
    ],
  },
  {
    id: "model-usage-report.yml",
    label: "Model usage report",
    source: ".github/workflows/model-usage-report.yml",
    trigger: "Cron Mon 05:00 UTC & 1st of month 05:10 UTC · manual (period + anchor)",
    manual: true,
    subFeatures: [
      { label: "report", detail: "Writes the dated model-usage markdown from pipeline_run_log." },
    ],
  },
  {
    id: "signal-freshness-check.yml",
    label: "Signal freshness check",
    source: ".github/workflows/signal-freshness-check.yml",
    trigger: "Cron 13:00 UTC, Mon–Fri · manual",
    manual: true,
    subFeatures: [
      { label: "check", detail: "Flags signals whose data is stale." },
    ],
  },
  {
    id: "backup-to-sqlite.yml",
    label: "Backup Neon to SQLite",
    source: ".github/workflows/backup-to-sqlite.yml",
    trigger: "Cron 03:00 UTC daily · manual",
    manual: true,
    subFeatures: [
      { label: "backup", detail: "Copies Neon tables into the local SQLite backup." },
      { label: "notify", detail: "Reports the outcome of the run." },
    ],
  },
  {
    id: "integration-tests.yml",
    label: "Integration tests (Neon branch)",
    source: ".github/workflows/integration-tests.yml",
    trigger: "Manual only",
    manual: true,
    subFeatures: [
      { label: "integration", detail: "Runs integration tests against a Neon branch." },
    ],
  },
  {
    id: "ci.yml",
    label: "CI",
    source: ".github/workflows/ci.yml",
    trigger: "Push to main & pull requests",
    manual: false,
    subFeatures: [
      { label: "test", detail: "Unit and component tests." },
      { label: "db-schema-parity", detail: "Checks the Postgres and SQLite schemas agree." },
      { label: "shared-drift-check", detail: "Checks shared modules have not drifted between surfaces." },
    ],
  },
  {
    id: "e2e-resiliency.yml",
    label: "E2E resiliency",
    source: ".github/workflows/e2e-resiliency.yml",
    trigger: "Push to main & pull requests",
    manual: false,
    subFeatures: [
      { label: "auth", detail: "Signs in through the auth flow." },
      { label: "e2e", detail: "Runs the Playwright end-to-end specs." },
      { label: "report", detail: "Publishes the E2E report." },
    ],
  },
];

const MODAL_APPS: CatalogEntry[] = [
  {
    id: "free-model-refresh",
    label: "Free model refresh",
    source: "deploy/free-model-refresh/modal_app.py",
    trigger: "Cron Mon 09:00 UTC · manual (modal run)",
    manual: true,
    subFeatures: [
      { label: "weekly_refresh", detail: "Scheduled refresh of the free model chain." },
      { label: "main", detail: "Local entrypoint to run the refresh on demand." },
    ],
  },
  {
    id: "nuwrrrld-precompute-ai",
    label: "Precompute AI",
    source: "deploy/precompute-ai/modal_app.py",
    trigger: "No schedule — GitHub Actions owns the 00:10 UTC run · manual (modal run)",
    manual: true,
    pipeline: "precompute-ai",
    subFeatures: [
      { label: "precompute_ai", detail: "Same pipeline as the GHA job, runnable on Modal." },
      { label: "main", detail: "Local entrypoint to run it on demand." },
    ],
  },
  {
    id: "nuwrrrld-universe-hydration",
    label: "Universe hydration",
    source: "deploy/universe-hydration/modal_app.py",
    trigger: "Cron 00:05 UTC daily · manual (modal run, optional symbols)",
    manual: true,
    subFeatures: [
      { label: "hydrate_universe_eod", detail: "Computes end-of-day indicators and confluence for the universe." },
      { label: "main", detail: "Local entrypoint; accepts a symbols list." },
    ],
  },
];

export const GITHUB_WORKFLOW_CATALOG: readonly CatalogEntry[] = GITHUB_WORKFLOWS;
export const MODAL_APP_CATALOG: readonly CatalogEntry[] = MODAL_APPS;
