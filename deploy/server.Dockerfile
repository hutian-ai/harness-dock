# Build with a portable server bundle as context; no credentials or Provider dependencies.
FROM node:22.22.2-bookworm-slim
WORKDIR /app
COPY --chown=root:root . ./
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run", "/run/harness-dock/server.json"]
