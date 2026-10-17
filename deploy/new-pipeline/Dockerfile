# Credential preflight only. build-image.sh sends an explicit two-file context.
FROM node:22-bookworm-slim
WORKDIR /app
COPY preflight.mjs ./preflight.mjs
USER node
ENTRYPOINT ["node", "preflight.mjs"]
