# Free-model chain refresh — deployment

Keeps `lib/openrouter.ts`'s `FREE_MODEL_CHAIN` pointed at models that are
actually free **and** actually reachable, by running
[`scripts/refresh-free-models.mjs`](../../scripts/refresh-free-models.mjs)
on a weekly schedule across **three independent platforms** so no single outage
lets the chain rot.

## Pieces

| File | Role |
|------|------|
| `../../scripts/refresh-free-models.mjs` | The core: probe OpenRouter's free catalog, rewrite the chain. |
| `../../scripts/run-refresh-remote.sh` | Portable wrapper: clone → refresh → open/update PR if changed. |
| `Dockerfile` | Cloud Run Job image (node + git + gh). |
| `deploy-gcp.sh` | Deploy the Cloud Run Job + weekly Cloud Scheduler trigger. |
| `modal_app.py` | Modal scheduled function (weekly cron). |
| `zo-automation.md` | Zo automation setup (weekly). |

## The one shared secret

Every remote runner needs to push the refreshed chain back to GitHub, so each
platform needs two secrets:

- `OPENROUTER_API_KEY` — for the live probe.
- `GH_TOKEN` — a GitHub **fine-grained PAT** scoped to `adamaslan/nuwrrrld-portal`
  with **Contents: read/write** and **Pull requests: read/write**.

Set `OPEN_PR=0` to push straight to `main` instead of opening a PR.

## Platforms

- **GCP** — `bash deploy-gcp.sh` (needs the two secrets in Secret Manager first).
- **Modal** — `modal secret create free-model-refresh …` then `modal deploy modal_app.py`.
- **Zo** — see `zo-automation.md`.

All three are idempotent: whichever fires first writes the current chain; the
others no-op when nothing changed. The refresh script's own safety rail means a
run that can't find ≥1 working model exits non-zero and leaves the chain intact.
