# What still runs on GCP after the OpenRouter migration

**Phase 6** of
[openrouter-migration-and-db-parity-plan.md](openrouter-migration-and-db-parity-plan.md).
Mirrored in `gcp3/docs/gcp-remaining-surface.md`.

**Model inference = OpenRouter, everywhere. Storage + job hosting = still
GCP/Firestore, by design.** This page exists so a future reader who finds a
`google.cloud` import or a `GCP_PROJECT_ID` env var doesn't conclude the
OpenRouter migration was left half-finished — these are a deliberate, separate
boundary.

## What moved to OpenRouter

Every place this codebase makes a **model** call — an LLM completion, an
embedding, a structured extraction — goes through OpenRouter. See
`docs/openrouter-migration-and-db-parity-plan.md` §0.1 for the full
runtime-by-runtime audit (portal: already 100% OpenRouter; gcp3 backend:
Phases 1-4 close the last live `GEMINI_API_KEY` path and the naming debt).

## What stays on GCP — and why that's not a gap

| Surface | Where | Why it isn't part of the AI migration |
|---|---|---|
| **Firestore** | `gcp3/backend/firestore.py` (cache + feature store); `run_locfire.py` / `local_config.py` | A document database, not a model provider. Phase 9 gives it a real local (emulator) + backup (scheduled export) story, but the client stays Firestore. |
| **Firebase sync** | `gcp3/backend/firebase_sync.py` | Data sync, not inference. |
| **Cloud Run hosting** | `gcp3/cloudbuild.yaml`, gcp3 backend deploy | Where the Python backend *runs* — a hosting choice, orthogonal to which API it calls for a completion. |
| **`GCP_PROJECT_ID` / WIF / service-account auth** | gcp3 backend env, CI | Identity for the above two — Firestore and Cloud Run both need a GCP project; that's not an AI dependency. |

## The one-sentence test

If removing OpenRouter from the picture would make the surface non-functional,
it's AI and it's migrated. If removing *GCP* would make it non-functional
(Firestore reads, Cloud Run serving traffic), it's storage/hosting and it's
staying, on purpose, per this page.

## Non-goals

This plan does not attempt to move Firestore to another database, or Cloud Run
to another host. That would be a genuinely separate, much larger project with
its own migration plan — not a follow-on to "get AI off Google Cloud."
