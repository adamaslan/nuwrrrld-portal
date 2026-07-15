"""Modal deployment of the FREE_MODEL_CHAIN weekly refresh.

Spins a tiny container on a weekly cron, clones the portal repo, runs the
refresh, and opens/updates a PR if the chain changed. Scales to zero between
runs — you only pay for the ~30s it takes to probe.

Deploy (one-time):
    pip install modal
    modal token new                       # authenticate
    modal secret create free-model-refresh \\
        OPENROUTER_API_KEY=sk-or-... \\
        GH_TOKEN=github_pat_...            # PAT: contents:write + pull_requests:write
    modal deploy deploy/free-model-refresh/modal_app.py

Run once manually:
    modal run deploy/free-model-refresh/modal_app.py
"""

import subprocess
from pathlib import Path

import modal

# Baked into the image at build time rather than curled from GitHub `main` at
# runtime — curling a remote script into a container on every scheduled run is
# a supply-chain risk (a compromised or edited `main` gets executed with the
# job's secrets) and makes it impossible to test changes on another branch.
RUNNER_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "run-refresh-remote.sh"

image = (
    modal.Image.debian_slim()
    .apt_install("git", "curl", "ca-certificates", "gnupg", "nodejs")
    # gh CLI for PR creation
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
    .add_local_file(str(RUNNER_SCRIPT), "/app/run-refresh-remote.sh")
)

app = modal.App("free-model-refresh")


def _run_refresh() -> None:
    """Execute the wrapper baked into the image."""
    subprocess.run(
        "bash /app/run-refresh-remote.sh",
        shell=True,
        check=True,
    )


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("free-model-refresh")],
    schedule=modal.Cron("0 9 * * 1"),  # Mondays 09:00 UTC
    timeout=600,
)
def weekly_refresh() -> None:
    _run_refresh()


@app.local_entrypoint()
def main() -> None:
    weekly_refresh.remote()
