# Cloud Run Job image for the weekly FREE_MODEL_CHAIN refresh.
# Build context is the repo root (see cloudbuild.yaml) so the runner script is
# baked in at build time rather than curled from GitHub `main` at runtime —
# curling a remote script into the container on every scheduled run is a
# supply-chain risk (a compromised or edited `main` gets executed with the
# job's secrets) and makes it impossible to test changes on another branch.
FROM node:20-slim

RUN mkdir -p /usr/share/keyrings \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY scripts/run-refresh-remote.sh ./run-refresh-remote.sh
ENTRYPOINT ["bash", "run-refresh-remote.sh"]
