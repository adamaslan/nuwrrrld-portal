# Cloud Run Job image for the weekly FREE_MODEL_CHAIN refresh.
# Tiny: node-slim + git + gh, running the portable remote wrapper.
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Only the wrapper is baked in; it clones the repo (incl. refresh-free-models.mjs)
# fresh at runtime, so the image never carries a stale copy of the script.
COPY scripts/run-refresh-remote.sh ./scripts/
RUN chmod +x scripts/run-refresh-remote.sh

ENTRYPOINT ["bash", "scripts/run-refresh-remote.sh"]
