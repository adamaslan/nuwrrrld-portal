"""Modal deployment of the nightly AI precompute (Option D).

The scheduling *is* the design. OpenRouter's free tier caps the whole API key
at some number of requests/day (this account's `auth/key` endpoint reports
`limit: null` — not independently confirmed here as 50 vs. 1000; see
docs/max-coverage-simplest-path.md "Correction" section) and resets at UTC
midnight. Today batch AI work and interactive Nu AI chat compete for that
single bucket, and batch usually wins simply by running first — so a user
asking a question in the afternoon can find the allowance already spent on a
narrative nobody was waiting for.

This job runs a few minutes *after* the reset, when the quota is at its
freshest, generates the batch artifacts, and stores them in Neon. The app then
serves them as ordinary cached reads at zero quota cost, leaving the day's
allowance for calls a user is actually waiting on.

Free-tier quota is a renewable resource with a schedule; a scheduler is the
right tool for spending a scheduled resource.

Deploy (one-time):
    pip install modal
    modal token new
    modal secret create nuwrrrld-precompute \\
        PORTAL_PUSH_SECRET=... \\
        PORTAL_URL=https://financial.nuwrrrld.com
    modal deploy deploy/precompute-ai/modal_app.py

Run once manually (bypasses the cron):
    modal run deploy/precompute-ai/modal_app.py
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


@app.function(
    image=image,
    # 00:10 UTC daily — a few minutes after OpenRouter's free-tier reset at UTC
    # midnight, so the run gets the freshest possible quota. Not on the hour:
    # the reset itself is a busy moment across every free-tier account, and a
    # small offset avoids racing it.
    schedule=modal.Cron("10 0 * * *"),
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
        response.raise_for_status()
        result = response.json()

    generated = result.get("generated", 0)
    attempted = result.get("attempted", 0)
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
