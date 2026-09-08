"""Modal runner for the AI precompute (Option D) — MANUAL / FAILOVER ONLY.

The scheduling rationale is real: OpenRouter's free tier caps the whole API key
at some number of requests/day (this account's `auth/key` endpoint reports
`limit: null` — not independently confirmed here as 50 vs. 1000; see
docs/max-coverage-simplest-path.md "Correction" section) and resets at UTC
midnight. Batch AI work and interactive Nu AI chat compete for that single
bucket, and batch wins by running first — so the batch is run a few minutes
*after* the reset, generated into Neon, and served as cached reads at zero
quota cost for the rest of the day.

**But this file does not own that schedule.** `.github/workflows/precompute-ai.yml`
is the live scheduler (docs/deploy-runner-decision.md, Finding 1). This module
carries NO `schedule=` — running both would double-spend the shared quota on
identical output (incident-2026-09-04-precompute-ai-double-schedule). It stays
here as a deployable manual runner: a one-off backfill, or failover if GHA is
down.

Run once manually:
    pip install modal
    modal token new
    modal secret create nuwrrrld-precompute \\
        PORTAL_PUSH_SECRET=... \\
        PORTAL_URL=https://financial.nuwrrrld.com
    modal run deploy/precompute-ai/modal_app.py

If GHA is being retired and Modal is taking over the schedule, re-add
`schedule=modal.Cron("10 0 * * *")` to the @app.function below IN THE SAME
CHANGE that disables the GHA workflow — never with both active.
"""

import os

import modal

app = modal.App("nuwrrrld-precompute-ai")

# httpx only — this function never touches market data or models directly; it
# just calls one authenticated portal endpoint, so the image stays tiny and
# scales to zero between nightly runs.
image = modal.Image.debian_slim(python_version="3.11").pip_install("httpx")

_SECRET = modal.Secret.from_name("nuwrrrld-precompute")

# How many distinct watchlist ticker-sets to precompute per run. Deliberately
# well under the free-tier cap (unconfirmed exact size — see the docstring
# above): the point of this job is to *protect* the interactive allowance, so
# it must never be the thing that exhausts it. The route enforces its own
# ceiling too — this is the outer of two bounds.
MAX_SUBJECTS = 10

HTTP_TIMEOUT_S = 300.0


def _portal_base() -> str:
    return os.environ.get("PORTAL_URL", "https://financial.nuwrrrld.com").rstrip("/")


# NO `schedule=` here — deliberately.
#
# .github/workflows/precompute-ai.yml owns the daily 00:10 UTC schedule for
# this exact endpoint. This file previously also carried
# `schedule=modal.Cron("10 0 * * *")` — the *same minute* — so if this app were
# ever `modal deploy`-ed, both runners would fire nightly and double the draw
# against the single shared OpenRouter free-tier quota bucket for identical
# output (incident-2026-09-04-precompute-ai-double-schedule).
#
# The pair is a documented either/or; GitHub Actions is the chosen live
# scheduler (docs/deploy-runner-decision.md, Finding 1). This function stays
# deployable and runnable on demand (`modal run deploy/precompute-ai/modal_app.py`)
# for a one-off backfill or to fail over if GHA is down — it just doesn't
# self-schedule. Re-add a `schedule=` here ONLY as part of disabling the GHA
# workflow, never alongside it.
@app.function(
    image=image,
    secrets=[_SECRET],
    timeout=900,
    retries=modal.Retries(max_retries=1, initial_delay=120.0),
)
def precompute_ai() -> dict:
    """Call POST /api/pipeline/precompute-ai once, and report what it produced."""
    import httpx

    secret = os.environ.get("PORTAL_PUSH_SECRET")
    if not secret:
        # Fail loudly rather than silently no-op: a precompute job that quietly
        # does nothing looks identical to one that ran fine, and the only
        # symptom is the app spending quota it did not need to.
        raise RuntimeError(
            "PORTAL_PUSH_SECRET is not set in the nuwrrrld-precompute Modal secret"
        )

    url = f"{_portal_base()}/api/pipeline/precompute-ai"
    with httpx.Client(timeout=HTTP_TIMEOUT_S) as client:
        response = client.post(
            url,
            headers={"Authorization": f"Bearer {secret}"},
            json={"maxSubjects": MAX_SUBJECTS},
        )
        # The route now returns 502 (not a clean 200) when it attempted
        # subjects and generated nothing, so this actually catches a dead run.
        # Surface the body's failureMode before re-raising so the Modal log
        # says *why*, not just "502".
        if response.status_code >= 400:
            try:
                body = response.json()
            except ValueError:
                body = {}
            print(
                f"[precompute] HTTP {response.status_code} "
                f"failureMode={body.get('failureMode')} "
                f"generated={body.get('generated')}/{body.get('attempted')}"
            )
            response.raise_for_status()
        result = response.json()

    generated = result.get("generated", 0)
    attempted = result.get("attempted", 0)
    if result.get("budgetStopped"):
        print("[precompute] NOTE: run stopped early to stay inside maxDuration — partial batch.")
    print(f"[precompute] generated={generated}/{attempted}")

    if result.get("quotaExhausted"):
        # Worth surfacing in the Modal logs: it means the daily allowance was
        # already gone at 00:10 UTC, which points at something else consuming
        # it (a stuck retry loop, another job) rather than normal user traffic.
        print(
            "[precompute] WARNING: daily free-model quota was already exhausted — "
            "something is spending it before the nightly run."
        )

    for item in result.get("results", []):
        if not item.get("ok"):
            print(f"[precompute] FAILED {item.get('subject')}: {item.get('reason')}")

    return result


@app.local_entrypoint()
def main() -> None:
    precompute_ai.remote()
