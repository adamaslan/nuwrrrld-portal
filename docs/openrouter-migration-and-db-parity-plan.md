# OpenRouter Migration + DB Parity Plan

**Status:** draft · **Date:** 2026-09-03 · **Branch:** `docs/openrouter-migration-plan`

Two goals, tracked together because they touch the same runtimes:

1. **Move every AI call off Google Cloud (Gemini / Vertex AI) and onto OpenRouter**, across every place model calls run: `gcp3` backend, `nuwrrrld-portal`, Modal jobs, GitHub Actions, and the mobile app.
2. **Confirm the three data-layer variants — local, backup, and Firestore — actually run the same code**, and close the gaps where they don't.

Delivered as small, independently-reviewable PRs. Each phase below is one PR unless noted.

---

## 0. Current state (audit findings)

### 0.1 AI provider — where each runtime stands today

| Runtime | AI calls today | Google/Gemini still present? |
|---|---|---|
| **nuwrrrld-portal** (Next.js) | 100% OpenRouter — `lib/openrouter.ts`, free-model fallback chain, `refresh-free-models` workflow | **No.** Already migrated. Grep for `vertexai\|generativeai\|GoogleGenerativeAI\|gemini-` in non-test code returns nothing. |
| **gcp3 backend** (Python) | Mostly OpenRouter + Mistral. `provider_router.py` order = `["openrouter_qwen3", "mistral", "gemini"]`; `GeminiProvider` is a **stub that raises**. `gemini_client.py` is misnamed — it is already *Mistral primary, OpenRouter fallback*. | **Residual.** `sector_rotation.py:76` still reads `GEMINI_API_KEY` directly (falls back to rule-based). ~7 modules still `import call_gemini from gemini_client` — naming/During-call debt, not live Gemini traffic. |
| **Modal jobs** (`portal/deploy/*/modal_app.py`) | None directly — they are thin authenticated HTTP triggers that call portal endpoints (which use OpenRouter). | **No** model calls. `deploy/free-model-refresh/` ships a `deploy-gcp.sh` + `cloudbuild.yaml` as a Cloud Run *alternative* to Modal — infra choice, not an AI-provider choice. |
| **GitHub Actions** (`portal/.github/workflows/`) | `precompute-ai.yml`, `refresh-free-models.yml`, `judge-followed-tickers.yml`, etc. all trigger deployed endpoints — OpenRouter downstream. | **No.** `refresh-free-models.yml` is already OpenRouter-catalog-specific. |
| **gcp3-mobile** (Expo) | No direct AI SDK — calls the gcp3 backend / portal API. | **No.** |

**Net:** the portal is done. The real migration surface is **gcp3 backend** (one live `GEMINI_API_KEY` path + naming debt), plus a decision about the **Cloud Run deploy variant** of the Modal jobs.

### 0.2 Non-AI gcloud dependencies (out of scope for "move AI to OpenRouter", listed so they aren't confused with it)

- `gcp3/backend/firestore.py` → `google.cloud.firestore` (cache + feature store).
- `gcp3/backend/firebase_sync.py`, `cloudbuild.yaml`, Cloud Run, `GCP_PROJECT_ID`.
- `portal/deploy/free-model-refresh/deploy-gcp.sh` + `cloudbuild.yaml`.

These are storage/hosting, not model inference. This plan does **not** rip them out; Phase 6 only documents the boundary.

### 0.3 DB parity — the three variants

| Variant | Code path | Schema source |
|---|---|---|
| **Portal prod** | `lib/db.ts` → `@neondatabase/serverless` (Neon Postgres) | `lib/db/schema.sql` (Postgres dialect) |
| **Portal backup / local** | `scripts/backup-to-sqlite.mjs` (`node:sqlite`), `backup-to-sqlite.yml` (daily 03:00 UTC) | `lib/db/schema.sqlite.sql` (hand-maintained parallel file) |
| **gcp3 "local" + "firestore"** | `run_locfire.py` / `local_config.py` → **real Firestore** via `google-cloud-firestore`; `firestore.py` is the only client. Local == prod, same code. | No emulator, no SQLite mirror, no separate backup DB. |

**Answer to "do local / backup / firestore share the same code":**

- **gcp3:** yes for local-vs-Firestore (identical code, both hit real Firestore) — but there is **no backup DB at all**.
- **portal:** **no.** Prod runs Postgres SQL from ~15 `lib/*-db.ts` modules; the backup/local path replays into SQLite through a **second hand-written schema file** that can silently drift. The `*-db.ts` query strings must stay dialect-compatible with both, and nothing enforces that today.

Phases 7–8 close these.

---

## Phase 1 — Kill the last live Gemini path in gcp3

**PR:** `fix(gcp3): route sector_rotation through provider_router, drop GEMINI_API_KEY`

- Replace the direct `os.environ["GEMINI_API_KEY"]` call in `backend/sector_rotation.py` with a `structured_llm_call(...)` through `llm/provider_router.py`.
- Keep the existing rule-based fallback as the `ai_degraded` branch.
- Remove `GEMINI_API_KEY` from `local_config.py`, `.env.example`, Cloud Run env, and any workflow `env:` block.
- **Tests:** unit test that `sector_rotation` produces output with `provider_order` forced to `["openrouter_qwen3"]` and again with all providers stubbed to fail (rule-based path).
- **Done when:** `grep -rn "GEMINI_API_KEY\|GOOGLE_API_KEY" backend/` returns only comments/docs.

---

## Phase 2 — Rename the `gemini_client` shim, delete the Gemini stub provider

**PR:** `refactor(gcp3): gemini_client → llm_client, remove GeminiProvider`

- Rename `backend/gemini_client.py` → `backend/llm/legacy_client.py` (or fold into `llm/structured_call.py`); rename `call_gemini` → `call_llm`. Update the ~7 importers (`story_picker`, `ai_summary`, `correlation_article`, `blog_reviewer`, `daily_blog`, `llm/structured_call`, tests).
- Delete `llm/providers/gemini.py` and the `"gemini"` entry from `_PROVIDER_REGISTRY` + `DEFAULT_LLM_PROVIDER_ORDER` (now `["openrouter_qwen3", "mistral"]`).
- Pure rename + deletion — no behavior change. Keep a one-line module alias (`from llm.legacy_client import call_llm as call_gemini`) for one release if any external caller exists, then drop in a follow-up.
- **Done when:** no source file references `gemini` except historical docs; CI green.

---

## Phase 3 — Make OpenRouter the sole hard dependency, Mistral optional

**PR:** `chore(gcp3): OpenRouter primary, Mistral behind a flag`

- Confirm `DEFAULT_LLM_PROVIDER_ORDER` leads with `openrouter_qwen3`.
- Gate Mistral on `MISTRAL_KEY` presence — `DisabledProvider` already handles absence; add an explicit config log line so a missing key is visible, not silent.
- Document the single required secret: `OPENROUTER_API_KEY` (or `OPEN_ROUTER_KEY2`). One key, one provider, one quota bucket to reason about.
- **Tests:** provider-router test with only `OPENROUTER_API_KEY` set → all agents resolve.

---

## Phase 4 — Sweep the shared model-config / cost-logging code

**PR:** `refactor(gcp3): unify model IDs + pricing on OpenRouter catalog`

- `llm/pricing.py`, `llm/cost_logger.py`, `config/agent_config.py`: replace any Gemini/Vertex model IDs and per-token prices with OpenRouter catalog IDs (mirror the portal's `FREE_MODEL_CHAIN` philosophy — `:free` suffixed, $0-quota).
- Point gcp3 at the **same free-model refresh source** the portal uses (`scripts/refresh-free-models.mjs` output), or copy the small refresh script into gcp3 so both stay current from one catalog query.
- **Done when:** cost logs show only `openrouter/...` model IDs for a full pipeline run.

---

## Phase 5 — Decide the Modal-vs-Cloud-Run deploy variant for portal batch jobs

**PR (docs + delete):** `chore(deploy): pick one runner for free-model-refresh / precompute-ai`

- `deploy/free-model-refresh/` currently ships **both** `deploy-modal.sh` and `deploy-gcp.sh` (+ `cloudbuild.yaml`). `precompute-ai.yml` header explicitly says *run ONE of GHA or Modal, not both*.
- Choose per job:
  - **free-model-refresh:** keep GitHub Actions (`refresh-free-models.yml`) as canonical; move the GCP Cloud Run scripts to `file-archive/` (archive, never delete — per global docs rule).
  - **precompute-ai / universe-hydration:** keep Modal (needs to outlive the 6h GHA ceiling / fan out per-ticker) *or* GHA — document the single choice in each `modal_app.py` header and disable the other's schedule.
- No AI-provider change here; this is removing a fork so there's one path to keep on OpenRouter.

---

## Phase 6 — Document the gcloud boundary that stays

**PR:** `docs: what still runs on GCP after the OpenRouter migration`

- One page: `docs/gcp-remaining-surface.md` (portal) + mirror note in `gcp3/docs/`.
- Enumerate: Firestore (cache + feature store), `firebase_sync`, Cloud Run hosting, `GCP_PROJECT_ID`, WIF/service-account auth.
- State explicitly: **model inference = OpenRouter; storage + job hosting = still GCP/Firestore by design.** Prevents a future reader from thinking the migration is half-done.

---

## Phase 7 — Portal: single-source the Postgres ↔ SQLite schema

**PR:** `fix(db): generate schema.sqlite.sql from schema.sql, don't hand-maintain`

- `lib/db/schema.sqlite.sql` is a parallel hand-written file → drift risk. Replace with a generator: `scripts/gen-sqlite-schema.mjs` reads `schema.sql`, rewrites Postgres-isms (`SERIAL` → `INTEGER PRIMARY KEY AUTOINCREMENT`, `JSONB` → `TEXT`, `TIMESTAMPTZ` → `TEXT`, `gen_random_uuid()` → app-side, partial indexes, etc.), emits `schema.sqlite.sql`.
- CI check in `ci.yml`: regenerate and `git diff --exit-code` so a `schema.sql` edit that isn't reflected fails the build.
- **Tests:** `backup-to-sqlite` job restores into the generated schema and round-trips a sample row per table.
- **Done when:** `schema.sqlite.sql` carries a "GENERATED — do not edit" header and CI enforces it.

---

## Phase 8 — Portal: contract-test the `lib/*-db.ts` query layer against both engines

**PR:** `test(db): run the db-module query suite against Neon and SQLite`

- Add a parametrized test harness that loads each `lib/*-db.ts` module against (a) a throwaway Neon branch and (b) an in-memory `node:sqlite` DB built from the generated schema.
- Every exported read/write function runs once per engine; assert shape-equality.
- Catches the real failure mode: a Postgres-only construct (`ON CONFLICT ... RETURNING`, `array_agg`, `->>`) landing in a `*-db.ts` string that the backup path can't replay.
- **Done when:** the suite is in `ci.yml` and green for all ~15 modules.

---

## Phase 9 — gcp3: give the local/backup path a real story

**PR:** `feat(gcp3): Firestore emulator for local + scheduled export for backup`

- **Local:** wire `run_locfire.py` to the **Firestore emulator** (`FIRESTORE_EMULATOR_HOST`) so local runs need no `google-cloud-firestore` creds and don't touch prod data. `firestore.py::db()` already keys off `GCP_PROJECT_ID` — add emulator detection.
- **Backup:** add a scheduled job (GHA or Cloud Scheduler) that exports the `gcp3_cache` + feature-store collections to a portable NDJSON/SQLite artifact, mirroring the portal's `backup-to-sqlite` pattern. 14-day artifact retention, read-only.
- **Done when:** `local == emulator`, `prod == Firestore`, `backup == daily export artifact` — three paths, one client (`firestore.py`), documented parity.

---

## Suggested merge order

Overlap is low; still, merge in this order to keep rebases trivial:

1. Phase 1 → 2 → 3 → 4 (gcp3 AI, strictly sequential — each builds on the last)
2. Phase 5, Phase 6 (deploy/docs — independent, any time)
3. Phase 7 → 8 (portal DB — 8 depends on 7's generator)
4. Phase 9 (gcp3 DB — independent of portal DB work)

Phases 1–4 touch only `gcp3/backend/`; Phases 7–8 touch only `nuwrrrld-portal/lib/` + `scripts/` + `ci.yml`. No cross-repo file conflicts.

---

## Rollback

- **AI (Phases 1–4):** re-add the provider to `DEFAULT_LLM_PROVIDER_ORDER` and restore the key. `provider_router.py`'s circuit breaker + fallback already tolerate a provider vanishing, so a bad OpenRouter day degrades to rule-based rather than erroring — the migration does not reduce resilience.
- **DB (Phases 7–9):** the generator and contract tests are additive; reverting the PR restores the hand-written file. Phase 9's emulator is opt-in via env var.
