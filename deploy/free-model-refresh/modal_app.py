"""Modal deployment: read-only health check of the committed FREE_MODEL_CHAIN.

Role (distinct from the GitHub Actions refresh, which stays the only chain
writer): every Wednesday at 09:00 UTC this container re-verifies the ids the
default branch ships. It reads lib/openrouter.ts through the GitHub API,
checks $0 pricing against the OpenRouter catalog, probes committed free models
within hard caps, and alerts through ntfy. It never clones for writing, never
opens PRs, and never edits the chain.

Deploy (owner-approved, one time):
    modal secret create free-model-refresh \\
        OPENROUTER_API_KEY=sk-or-... \\
        GH_TOKEN=github_pat_...            # read-only: contents:read on the portal repo
        NTFY_TOPIC=nwf-...                 # long random topic; subscribe in the ntfy app
    modal deploy deploy/free-model-refresh/modal_app.py

Run once manually (verification):
    modal run deploy/free-model-refresh/modal_app.py

The state volume holds the last alert signature so a standing regression
alerts once, not every Wednesday.

Note: the GCP Cloud Run copy of the refresh (deploy/free-model-refresh/cloudbuild.yaml,
deploy-gcp.sh) is a separate owner decision and is not changed here.
"""

import os
import subprocess
from pathlib import Path

import modal

REPO_ROOT = Path(__file__).resolve().parents[2]
HEALTH_SCRIPT = REPO_ROOT / "scripts" / "free-model-health-check.mjs"
CHAIN_HELPER = REPO_ROOT / "scripts" / "free-model-chain.mjs"
STATE_DIR = "/state"

image = (
    modal.Image.debian_slim()
    # Node 18+ is required (AbortSignal.timeout, global fetch).
    .apt_install("curl", "ca-certificates", "gnupg", "nodejs")
    # gh CLI reads the committed chain through the GitHub API.
    .run_commands(
        "mkdir -p /usr/share/keyrings",
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
        "-o /usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] '
        'https://cli.github.com/packages stable main" '
        "> /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh",
    )
    # Baked in at build time, not fetched at runtime, so a changed main cannot run in this job.
    .add_local_file(str(HEALTH_SCRIPT), "/app/scripts/free-model-health-check.mjs")
    .add_local_file(str(CHAIN_HELPER), "/app/scripts/free-model-chain.mjs")
)

app = modal.App("free-model-refresh")
state_volume = modal.Volume.from_name("free-model-health-state", create_if_missing=True)


def _run_health_check() -> None:
    """Run the read-only check. Exit 2 (regression) and 4 (key) fail the Modal run on purpose."""
    # Inherit the container env: the Modal secret supplies OPENROUTER_API_KEY, GH_TOKEN and NTFY_TOPIC.
    env = {**os.environ, "HEALTH_STATE_FILE": f"{STATE_DIR}/health.json"}
    result = subprocess.run(
        ["node", "/app/scripts/free-model-health-check.mjs"],
        env=env,
        timeout=420,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"free-model health check exited {result.returncode}")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("free-model-refresh")],
    volumes={STATE_DIR: state_volume},
    schedule=modal.Cron("0 9 * * 3"),  # Wednesdays 09:00 UTC, away from the Monday refresh
    timeout=600,
)
def weekly_health_check() -> None:
    _run_health_check()


@app.local_entrypoint()
def main() -> None:
    weekly_health_check.remote()
