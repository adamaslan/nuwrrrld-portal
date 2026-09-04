# Modal — Deployment and Local Triggering

Everything Modal in the NuWrrrld stack: what exists, what is actually deployed,
how to run any of it from your own terminal, how to deploy it, and how the cron
schedules relate to the GitHub Actions workflows that overlap them.

**Written 2026-09-02.** Verified against `modal` CLI **1.5.2** and the live
`chillcoders` workspace on that date.

> **The single most important fact in this document:** of the six Modal apps in
> the codebase, **exactly one is deployed** (`free-model-refresh`). Everything
> else is source-only. `modal run` works on all six; `modal deploy` has been run
> on one. Do not assume a `modal.Cron(...)` in a file means a cron is firing —
> a schedule only exists after `modal deploy`.

---

## 1. Ground truth as of 2026-09-02

```
$ modal app list --json
[{"app_id":"ap-085dpOUqulcu4W3gbHxDcb","description":"free-model-refresh",
  "state":"deployed","tasks":"0","created_at":"2026-07-14 18:11:05-04:00",
  "stopped_at":null}]

$ modal secret list
nuwrrrld-secrets      created 2026-07-14 20:22 EDT   last used 2026-08-12 17:18 EDT
free-model-refresh    created 2026-07-14 18:11 EDT   last used 2026-08-31 05:00 EDT
```

`free-model-refresh`'s secret was last read at **2026-08-31 05:00 EDT = 09:00
UTC, a Monday** — which is exactly `modal.Cron("0 9 * * 1")`. The deployed cron
is live and firing. `nuwrrrld-secrets` has not been read since 2026-08-12,
consistent with the homebase apps not being deployed.

Two secrets exist. **Two more are referenced by source that has never been
deployed** (`nuwrrrld-hydration`, `nuwrrrld-precompute`) and do not exist in the
workspace — deploying those apps without creating the secret first fails at
deploy time, not at run time, because `modal.Secret.from_name()` is resolved
during app construction.

---

## 2. The full Modal inventory

Six apps across two repos. `~/code/nuwrrrld-portal` owns the portal-facing
pipeline; `~/code/homebase` owns the signal pipeline and the live-price stream.

| App name | File | Schedule in source | Deployed? | Secret | Timeout |
|---|---|---|---|---|---|
| `free-model-refresh` | `nuwrrrld-portal/deploy/free-model-refresh/modal_app.py` | `0 9 * * 1` (Mon 09:00 UTC) | ✅ **yes** | `free-model-refresh` | 600s |
| `nuwrrrld-universe-hydration` | `nuwrrrld-portal/deploy/universe-hydration/modal_app.py` | `5 0 * * *` (00:05 UTC) | ❌ no | `nuwrrrld-hydration` *(does not exist)* | 3600s |
| `nuwrrrld-precompute-ai` | `nuwrrrld-portal/deploy/precompute-ai/modal_app.py` | `10 0 * * *` (00:10 UTC) | ❌ no | `nuwrrrld-precompute` *(does not exist)* | 900s |
| `nuwrrrld-signals` | `homebase/modal_locrun.py` | `15 18 * * 1-5` (14:15 ET, EDT) | ❌ no | `nuwrrrld-secrets` | 600s |
| `nuwrrrld-drain` | `homebase/modal_drain.py` | `*/5 13-20 * * 1-5` (every 5 min, market hours) | ❌ no | `nuwrrrld-secrets` | 300s |
| `nuwrrrld-finnhub-ws` | `homebase/modal_finnhub_ws.py` | none (manual / long-running) | ❌ no | `nuwrrrld-secrets` | 8h |

### Which secret carries which variables

| Secret | Variables | Consumed by |
|---|---|---|
| `free-model-refresh` | `OPENROUTER_API_KEY`, `GH_TOKEN` | free-model-refresh |
| `nuwrrrld-hydration` *(to create)* | `PORTAL_PUSH_SECRET`, `PORTAL_URL`, `ALPACA_API_KEY`, `ALPACA_API_SECRET` | universe-hydration |
| `nuwrrrld-precompute` *(to create)* | `PORTAL_PUSH_SECRET`, `PORTAL_URL` | precompute-ai |
| `nuwrrrld-secrets` | `PORTAL_PUSH_SECRET`, `EXPO_PUBLIC_PORTAL_URL`, `FINNHUB_API_KEY2`/`FINNHUB_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS_JSON` | signals, drain, finnhub-ws |

`GH_TOKEN` is a **fine-grained PAT** scoped to `adamaslan/nuwrrrld-portal` with
Contents: read/write and Pull requests: read/write. Nothing here holds a
`DATABASE_URL` — every write goes through an authenticated portal route so
validation, idempotency and the replacement rule live in one place.

---

## 3. Local setup

### The environment

Modal is installed in **two** places on this machine, both at 1.5.2:

```bash
/opt/homebrew/Caskroom/miniforge/base/bin/modal                 # base (py3.12)
/opt/homebrew/Caskroom/miniforge/base/envs/modal1/bin/modal     # modal1 (py3.12.13)
```

Use `modal1` — it exists for this. Per the mamba rules, never `pip install`
outside an env:

```bash
mamba activate modal1
modal --version        # 1.5.2
```

If `modal` is "command not found", you are in a shell that never activated the
env. Either activate it or call the absolute path.

### Authentication

`~/.modal.toml` already holds an active `chillcoders` profile (`token_id` /
`token_secret`). Nothing to do. To verify without printing the token:

```bash
modal profile list
modal app list          # a successful call proves the token works
```

Only re-run `modal token new` if the token was revoked. It **overwrites**
`~/.modal.toml` — back the file up first if it carries more than one profile.

### macOS gotcha

`timeout` is not on the PATH here (GNU coreutils isn't installed). Don't wrap
Modal commands in it; use the tool's own flags or `gtimeout` if you install
coreutils.

---

## 4. Local triggering — running a Modal function from your terminal

This is the part worth internalizing: **`modal run` does not run the code on
your laptop.** It builds (or reuses) the image, ships it to Modal's cloud,
executes there, and streams the logs back. Your machine contributes the source
and the auth token, nothing else. That means a local trigger uses the *real*
secrets and hits the *real* portal — there is no "local mode" that sandboxes
side effects.

### The four invocation shapes

```bash
# 1. Whole file — resolves the single @app.local_entrypoint()
modal run deploy/precompute-ai/modal_app.py

# 2. A specific entrypoint or function by name
modal run deploy/universe-hydration/modal_app.py::hydrate_universe_eod

# 3. Via the app variable
modal run deploy/universe-hydration/modal_app.py::app.hydrate_universe_eod

# 4. As a module path (keeps remote module names identical to local)
modal run -m deploy.precompute-ai.modal_app
```

### Passing arguments

Every parameter of the `local_entrypoint` becomes a CLI flag, and Modal
type-coerces from the annotation. The universe-hydration entrypoint takes a
comma-separated string precisely so you can smoke-test the whole path without
walking ~933 symbols:

```bash
# 3 tickers instead of the full universe — seconds, not minutes
modal run deploy/universe-hydration/modal_app.py --symbols AAPL,MSFT,NVDA

# homebase: 2 minutes of live Finnhub trades, then stop
cd ~/code/homebase && modal run modal_finnhub_ws.py --minutes 2

# homebase: signal pipeline scoped to one universe
cd ~/code/homebase && modal run modal_locrun.py --universe etf
```

Flags are the *entrypoint's* parameters, not the scheduled function's. Where a
`local_entrypoint` takes `symbols: str = ""` and forwards a parsed list to the
remote function, `--symbols AAPL,MSFT` is right and `--symbols '["AAPL"]'` is
not.

### Useful run flags

| Flag | Why you'd use it |
|---|---|
| `-d` / `--detach` | Keep running after you close the terminal or lose wifi. Essential for the 3600s hydration walk. |
| `-q` / `--quiet` | Drop the progress spinners; better in a pipe or a log. |
| `-n NAME` | Label this run in the dashboard, so a manual backfill is distinguishable from a cron fire. |
| `--timestamps` | Prefix each log line with a timestamp. |
| `-w PATH` | Write the return value to a local file (must be `str`/`bytes`). |
| `-e ENV` | Target a non-default Modal environment. |
| `-i` | Interactive — drops you into a breakpoint in the container. |

### Triggering a *deployed* function without redeploying

`modal run` on a file that is also deployed creates a separate ephemeral app
run; it does not touch the deployment. To invoke the deployed function itself
— the one the cron calls, with the deployed image — use a lookup from Python:

```bash
python - <<'PY'
import modal
f = modal.Function.from_name("free-model-refresh", "weekly_refresh")
print(f.remote())          # blocking; use .spawn() for fire-and-forget
PY
```

Use this to answer "does the *deployed* thing still work" — `modal run` only
answers "does the *source* still work", and after a drifted deploy those are
different questions.

### Shell into the image

```bash
modal shell deploy/universe-hydration/modal_app.py::hydrate_universe_eod
```

Same image, same secrets, interactive. The fastest way to debug "why does
pandas behave differently up there".

---

## 5. Deployment

### One-time, per app

```bash
mamba activate modal1
cd ~/code/nuwrrrld-portal

# 1. Create the secret the app names (only if it doesn't already exist)
modal secret create nuwrrrld-precompute \
  PORTAL_PUSH_SECRET=... \
  PORTAL_URL=https://financial.nuwrrrld.com

# 2. Deploy — this is what makes the modal.Cron real
modal deploy deploy/precompute-ai/modal_app.py
```

⚠️ **Do not paste real secret values into a chat session or a shell that logs
history.** Prefer the dotenv path, which never routes the value through a
prompt or an LLM context:

```bash
modal secret create nuwrrrld-precompute --from-dotenv .env.modal.precompute
modal secret create nuwrrrld-hydration  --from-json  ~/secure/hydration.json
```

`--force` overwrites an existing secret. Overwriting is how you *rotate*; there
is no merge — the new set replaces the old set entirely, so a `--force` that
omits a key silently removes it and the next run fails on `_require()`.

### Deploy flags worth knowing

| Flag | Effect |
|---|---|
| `--name TEXT` | Override the deployment name (defaults to `modal.App("…")`). |
| `--tag TEXT` | Version-tag this deployment, so `modal app rollback` has something to name. |
| `--stream-logs` | Watch the first run's logs immediately after deploy. |
| `--strategy rolling\|recreate` | `rolling` keeps old containers alive during the swap; `recreate` tears down first. |
| `-e ENV` | Deploy into a named Modal environment (e.g. a `staging` env). |
| `-m` | Treat the argument as a module path. |

### Deploying the not-yet-deployed apps

```bash
# portal
modal deploy deploy/universe-hydration/modal_app.py     # needs nuwrrrld-hydration first
modal deploy deploy/precompute-ai/modal_app.py          # needs nuwrrrld-precompute first

# homebase
cd ~/code/homebase
modal deploy modal_locrun.py
modal deploy modal_drain.py
modal deploy modal_finnhub_ws.py                        # no schedule; deploy only for lookup/spawn
```

**Read §7 before deploying the portal pair** — both duplicate a live GitHub
Actions workflow, and running both costs real quota for identical output.

### Rollback and redeploy

```bash
modal app history free-model-refresh    # what versions exist
modal app rollback free-model-refresh   # previous version
modal app rollover free-model-refresh   # same code, fresh containers
```

`rollover` is the one to reach for when a container has stale state or a
mounted file went bad — no code change, new containers.

---

## 6. Operating a deployed app

```bash
modal app list                                    # state, tasks, created_at
modal app list --json                             # scriptable; no table truncation
modal app logs free-model-refresh                 # recent logs
modal app logs free-model-refresh -f              # follow
modal app logs free-model-refresh --since 7d --search "coverage"
modal app logs free-model-refresh -s stderr -n 100
modal app dashboard free-model-refresh            # open the web UI
modal app stop free-model-refresh                 # ⚠️ permanent; kills the cron
```

⚠️ `modal app stop` **permanently stops the app and terminates its containers**.
For `free-model-refresh` that silently ends the weekly chain refresh — the
symptom is not an error but `FREE_MODEL_CHAIN` slowly rotting as free models
get delisted. Redeploy is the only way back.

Set `COLUMNS=200` before table-producing commands, or the Rich tables truncate
columns to your terminal width and quietly hide the `stopped_at` field.

### Log-line conventions in these apps

The portal jobs print structured, greppable prefixes. Use them:

```bash
modal app logs nuwrrrld-universe-hydration --search "[hydrate] done"
modal app logs nuwrrrld-precompute-ai --search "WARNING"
```

`[precompute] WARNING: daily free-model quota was already exhausted` at 00:10
UTC is the signal that something *else* is spending the OpenRouter allowance
before the nightly run — usually a stuck retry loop or a second scheduler.

---

## 7. The overlap problem: Modal vs. GitHub Actions

Three of these jobs exist **twice** — once as a Modal app, once as a GHA
workflow. This is deliberate multi-platform redundancy in the design docs, but
redundancy for a *write* job is duplication, not resilience.

| Job | GHA workflow | GHA cron | Modal cron | Both live? |
|---|---|---|---|---|
| Free-model refresh | `.github/workflows/refresh-free-models.yml` | `17 6 * * 1` | `0 9 * * 1` | ⚠️ **yes** |
| Universe hydration | `.github/workflows/hydrate-universe.yml` | `30 22 * * *` (post-close) | `5 0 * * *` | no (Modal not deployed) |
| AI precompute | `.github/workflows/precompute-ai.yml` | `10 0 * * *` | `10 0 * * *` | no (Modal not deployed) |

**Free-model refresh currently runs on both platforms every Monday** — GHA at
06:17 UTC, Modal at 09:00 UTC. This is mostly benign by construction: both are
idempotent, and whichever runs second finds nothing changed and no-ops. The
real cost is two probe passes against the OpenRouter catalog and the
possibility of two PRs in the same week if a model flaps between 06:17 and
09:00. Worth consolidating; not urgent.

**The precompute pair is the dangerous one.** Both are scheduled at `10 0 * * *`
and both `POST /api/pipeline/precompute-ai`. Deploying the Modal app without
disabling the workflow means two schedulers hitting the same endpoint at the
same minute — doubling the spend of the exact free-tier allowance the job exists
to protect, for identical output. `precompute-ai.yml`'s own header says it:
run **one** of them.

**Rule: before `modal deploy` of any portal app, disable its GHA twin** —
comment out the `schedule:` block (keep `workflow_dispatch` so the manual path
survives) and say so in the commit message.

### Which platform to pick

- **GHA is the default.** No extra account, secrets already live in the repo,
  the runner already has node and the repo checked out.
- **Modal wins when** the job exceeds GHA's 6-hour ceiling, needs to fan out
  per-ticker across containers, needs pandas/numpy without a setup step, needs
  a long-lived process (the Finnhub websocket is 8 hours and cannot be a GHA
  job at all), or needs GPU.
- The `universe-hydration` job is the one most likely to graduate to Modal: it
  is a 3600s pandas walk over ~933 symbols and its design comment already
  anticipates fanning out.

---

## 8. Anatomy — reading and writing one of these files

Every app here follows the same five-part shape.

```python
app = modal.App("nuwrrrld-precompute-ai")          # 1. the app name = the deploy name

image = (modal.Image.debian_slim(python_version="3.11")   # 2. the image
         .pip_install("httpx"))

_SECRET = modal.Secret.from_name("nuwrrrld-precompute")   # 3. secrets by name

@app.function(                                      # 4. the remote function
    image=image,
    schedule=modal.Cron("10 0 * * *"),
    secrets=[_SECRET],
    timeout=900,
    retries=modal.Retries(max_retries=1, initial_delay=120.0),
)
def precompute_ai() -> dict:
    import httpx                                    # heavy imports inside the fn
    ...

@app.local_entrypoint()                             # 5. what `modal run` calls
def main() -> None:
    precompute_ai.remote()
```

### Conventions this codebase holds to

- **Imports of image-only packages go inside the function.** `import httpx` at
  module scope would break `modal run` and `modal deploy` on any machine where
  httpx isn't installed locally, because Modal imports the module locally to
  discover the app.
- **`.remote()` from the entrypoint, never a direct call.** `precompute_ai()`
  would run locally and fail; `precompute_ai.remote()` runs in the container.
- **Fail loudly on a missing secret.** The `_require()` helper in
  `universe-hydration/modal_app.py` exists because the Zo pipeline's enrichment
  step self-skipped on a missing secret for weeks while its briefings kept
  shipping green. A missing secret is a configuration error, not a skip.
- **Nothing is baked from the network at runtime.** `free-model-refresh` uses
  `.add_local_file()` to bake `scripts/run-refresh-remote.sh` into the image
  rather than curling it from `main` at run time — curling a remote script into
  a container that holds a `GH_TOKEN` is a supply-chain risk and makes branch
  testing impossible.
- **Per-row isolation over per-run failure.** `_row_for()` never raises; one bad
  symbol becomes one error row, not a dead run.
- **Fail the run on degraded output.** Hydration raises below a 95% coverage
  floor, so a bad night is red in the Modal UI instead of silently green.

### Local files in the image

Two mechanisms, both used here:

```python
.add_local_file(str(RUNNER_SCRIPT), "/app/run-refresh-remote.sh")   # one file
.add_local_dir(_HOMEBASE_DIR, remote_path="/root/homebase")         # a whole dir
```

Both attach at the **end** of the image build and are re-uploaded on each
deploy, so they don't invalidate the pip layer. The homebase apps use the dir
form so `locrun.py` can import its siblings unmodified.

### Schedules

```python
modal.Cron("10 0 * * *")            # standard 5-field cron, UTC
modal.Period(hours=6)               # "every N since last run" — drifts, no wall clock
```

**Modal crons are UTC, always.** `modal_locrun.py`'s `15 18 * * 1-5` is 14:15
ET *during EDT only* — it silently becomes 13:15 ET when the US falls back in
November. The afternoon GHA pipeline handles this by registering both
`15 20 * * 1-5` and `15 19 * * 1-5` and gating inside the job; the Modal file
does not. If that app is ever deployed, fix the DST handling first.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: modal` | Shell never activated the env | `mamba activate modal1` |
| Deploy fails on `Secret.from_name` | The named secret doesn't exist in the workspace | `modal secret list`, then `modal secret create` |
| Run succeeds, nothing changed | Wrong `PORTAL_URL` in the secret, or hitting prod when you meant local | Print `_portal_base()` in the logs; check the secret |
| `RuntimeError: X is not set … refusing to run` | A `--force` secret rewrite dropped a key | Recreate the secret with the full set |
| Cron isn't firing | The app was never deployed, or was `modal app stop`ped | `modal app list`; redeploy |
| Coverage error below 95% | Vendor gaps or a chunk POST failure | `modal app logs … --search "chunk"` for the failing chunk |
| Duplicate PRs from the refresh job | GHA + Modal both firing weekly (§7) | Disable one platform's schedule |
| Table output truncated | Rich sizes to terminal width | `export COLUMNS=200` or use `--json` |
| Local edits not reflected in a deployed run | `modal run` uses source; the deployment uses the last deploy | `modal deploy` to update, or `modal app history` to see drift |

### Non-obvious ones

- **A `modal run` and a cron fire are indistinguishable in the logs** unless you
  pass `-n`. Name manual runs.
- **`modal run` without `-d` dies with your terminal.** A 3600s hydration walk
  started over ssh and abandoned is a half-hydrated universe.
- **`modal.Retries` retries the whole function**, not the failing chunk. The
  hydration POST is idempotent so a retry is safe; that is not automatic — it is
  a property of the portal route.

---

## 10. Quick reference

```bash
mamba activate modal1

# discover
modal app list --json
modal secret list
modal app history <app>

# run locally (executes in the cloud, logs stream to you)
modal run <file.py>
modal run <file.py>::<function>
modal run <file.py> --symbols AAPL,MSFT     # entrypoint args become flags
modal run -d -n backfill-2026-09-02 <file.py>

# invoke the *deployed* function
python -c 'import modal; print(modal.Function.from_name("APP","FN").remote())'

# deploy
modal secret create <name> --from-dotenv <file>
modal deploy <file.py> --tag v2 --stream-logs

# operate
modal app logs <app> -f
modal app logs <app> --since 7d --search "[hydrate] done"
modal app rollover <app>
modal app rollback <app>
modal app stop <app>          # ⚠️ permanent

# debug
modal shell <file.py>::<function>
```

---

## Related docs

- `docs/gha-modal-core-feature-coverage.md` — what else these two schedulers can carry
- `docs/modal-vs-gcp-signal-coverage.md` — why per-stock indicators live on Modal, not gcp3
- `docs/max-coverage-simplest-path.md` — the free-cards / paid-narratives split these crons implement
- `docs/running-universe-hydration-locally.md` — the pure-Node local path (`scripts/hydrate-local.mjs`), no Modal involved
- `deploy/free-model-refresh/README.md` — the three-platform refresh matrix (GCP / Modal / Zo)
