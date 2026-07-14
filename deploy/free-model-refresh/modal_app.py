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

import modal

RUNNER_URL = (
    "https://raw.githubusercontent.com/adamaslan/nuwrrrld-portal/"
    "main/scripts/run-refresh-remote.sh"
)

image = (
    modal.Image.debian_slim()
    .apt_install("git", "curl", "ca-certificates", "gnupg", "nodejs")
    # gh CLI for PR creation
    .run_commands(
        "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
        "| dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg",
        'echo "deb [arch=$(dpkg --print-architecture) '
        'signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] '
        'https://cli.github.com/packages stable main" '
        "> /etc/apt/sources.list.d/github-cli.list",
        "apt-get update && apt-get install -y gh",
    )
)

app = modal.App("free-model-refresh")


def _run_refresh() -> None:
    """Fetch the wrapper from the repo and execute it."""
    subprocess.run(
        f'curl -fsSL "{RUNNER_URL}" -o /tmp/run-refresh-remote.sh',
        shell=True,
        check=True,
    )
    subprocess.run(
        "bash /tmp/run-refresh-remote.sh",
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
