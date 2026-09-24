# The homelab server: web UI + sync worker. Built by compose.yaml.
FROM docker.io/library/node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Only the server's dependencies are installed (not TypeScript or vitest).
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @kiai/server && npm cache clean --force

COPY packages/server/src packages/server/src
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 8080
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Node 22 runs the TypeScript sources directly (type stripping); there is no build step.
ENTRYPOINT ["node", "packages/server/src/main.ts"]
CMD ["serve"]
