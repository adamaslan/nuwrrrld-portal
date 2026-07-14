# Cloud Run Job image for the weekly FREE_MODEL_CHAIN refresh.
# Self-contained: it fetches the portable runner from the repo's main branch at
# runtime (same as the Modal deploy), so the build context is just this file and
# the image never carries a stale copy of the scripts.
FROM node:20-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

ARG RUNNER_URL=https://raw.githubusercontent.com/adamaslan/nuwrrrld-portal/main/scripts/run-refresh-remote.sh
ENV RUNNER_URL=${RUNNER_URL}

WORKDIR /app
ENTRYPOINT ["bash", "-c", "curl -fsSL \"$RUNNER_URL\" -o run-refresh-remote.sh && bash run-refresh-remote.sh"]
