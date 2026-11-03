# Multi-stage Dockerfile for Jasmin Enterprise Web Dashboard
# Stage 1: Build TypeScript
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Minimal Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    JASMIN_CONFIG_PATH=/etc/jasmin/jasmin.cfg \
    JCLI_HOST=127.0.0.1 \
    JCLI_PORT=8990 \
    HTTP_API_URL=http://127.0.0.1:1401

# Run as non-root user (UID 1000) for security hardening
USER node

COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/overview || exit 1

CMD ["node", "dist/server.js"]

