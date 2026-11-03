# Multi-stage Dockerfile for Jasmin Enterprise Web Dashboard
# Hardened Wolfi container runtime without Alpine

# Stage 1: Build TypeScript and production dependencies
FROM ghcr.io/taha2samy-3/node:22-dev AS builder

WORKDIR /app

COPY --chown=node:node package*.json tsconfig.json ./
RUN npm ci

COPY --chown=node:node src/ ./src/
RUN npm run build

# Prune dev dependencies for minimal production footprint
RUN npm prune --omit=dev && npm cache clean --force

# Stage 2: Minimal Production Runtime
FROM ghcr.io/taha2samy-3/node:22 AS runner

LABEL maintainer="taha2samy-3 (Unofficial Community Distribution)"
LABEL description="Unofficial Enterprise Web Dashboard for Jasmin SMS Gateway on hardened Wolfi Linux"

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    JASMIN_CONFIG_PATH=/etc/jasmin/jasmin.cfg \
    JCLI_HOST=127.0.0.1 \
    JCLI_PORT=8990 \
    HTTP_API_URL=http://127.0.0.1:1401

# Run as non-root user (node: UID 1000) for security hardening
USER node

COPY --chown=node:node package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("http").get("http://127.0.0.1:3000/api/overview", (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on("error", () => process.exit(1))'

CMD ["node", "dist/server.js"]
