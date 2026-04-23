# syntax=docker/dockerfile:1.6
#
# p2p-hiverelay — P2P relay backbone for the Holepunch/Pear ecosystem.
#
# Multi-arch (linux/amd64, linux/arm64) — designed for Umbrel Home (ARM)
# AND x86 Umbrel/server hosts. Built via `docker buildx build --platform`.
#
# Multi-stage build:
#   Stage 1 (deps):    install production deps for all workspaces
#   Stage 2 (runtime): minimal Alpine runtime, non-root user, tini PID 1
#
# Build:
#   docker build -t p2p-hiverelay:latest .
#
# Multi-arch build (push to registry):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t hiverelay/hiverelay:0.6.0 -t hiverelay/hiverelay:latest --push .
#
# Quick run (data volume + API port published):
#   docker run -d --name hiverelay \
#     -v hiverelay-data:/data \
#     -p 9100:9100 \
#     p2p-hiverelay:latest
#
# Open the TUI (connects to the running container's API):
#   docker exec -it hiverelay hiverelay tui
#
# Environment overrides:
#   HIVERELAY_REGION=NA           (region code)
#   HIVERELAY_MAX_STORAGE=50GB    (accepts human-readable sizes)
#   HIVERELAY_API_KEY=...         (secures management endpoints)
#   HIVERELAY_API_PORT=9100       (API port inside container)
#   HIVERELAY_HOLESAIL=1          (enable Holesail for NAT traversal)
#   LNBITS_URL=http://...         (LNbits payment provider; auto-detected on Umbrel)
#   LNBITS_ADMIN_KEY=...          (LNbits admin key for invoice creation)

# ─── Stage 1: dependencies ────────────────────────────────────────────
# Use Alpine for the smaller image footprint critical on Pi-class Umbrel
# hardware. node:20 LTS — Bare/Pear runtime targets stay aligned.
FROM node:20-alpine AS deps
WORKDIR /app

# Install build tools needed for native deps (sodium-universal, hypercore-crypto)
RUN apk add --no-cache python3 make g++ git

# Copy ALL workspace package.json files (npm needs them all to resolve workspaces)
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/services/package.json packages/services/
COPY packages/client/package.json packages/client/

# Install production deps across all workspaces. --workspaces installs deps
# for every workspace; --include-workspace-root pulls in root devDeps if any
# are needed at runtime (none currently, but explicit is better).
RUN npm ci --omit=dev --workspaces --include-workspace-root --no-audit --no-fund

# ─── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="p2p-hiverelay"
LABEL org.opencontainers.image.description="Always-on P2P relay infrastructure for the Holepunch/Pear ecosystem"
LABEL org.opencontainers.image.source="https://github.com/bigdestiny2/P2P-Hiverelay"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# tini for proper PID 1 signal handling (graceful shutdown).
# wget for HEALTHCHECK without bringing curl/openssl bloat.
RUN apk add --no-cache tini wget

WORKDIR /app

# Bring in already-installed modules from the deps stage. This includes
# every workspace's node_modules (npm hoists most to the root), keeping
# the runtime image small.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/packages/services/node_modules ./packages/services/node_modules
COPY --from=deps /app/packages/client/node_modules ./packages/client/node_modules

# Copy application source (respects .dockerignore)
COPY . .

# Non-root user for security. Alpine uses addgroup/adduser instead of
# Debian's groupadd/useradd.
RUN addgroup -S hiverelay && \
    adduser -S -G hiverelay -h /data -s /sbin/nologin hiverelay && \
    mkdir -p /data /config && \
    chown -R hiverelay:hiverelay /app /data /config

# Make the hiverelay binary globally callable inside the container, so
# `docker exec -it hiverelay hiverelay tui` just works.
RUN ln -s /app/packages/core/cli/index.js /usr/local/bin/p2p-hiverelay && \
    ln -s /app/packages/core/cli/index.js /usr/local/bin/hiverelay && \
    chmod +x /app/packages/core/cli/index.js

USER hiverelay

VOLUME ["/data", "/config"]

# API port. Gateway (9200) and other transport ports may need their own
# `-p` mappings when you enable them.
EXPOSE 9100

ENV NODE_ENV=production \
    HIVERELAY_STORAGE=/data \
    HIVERELAY_CONFIG_DIR=/config \
    HIVERELAY_LOG_LEVEL=info \
    HIVERELAY_API_PORT=9100 \
    HIVERELAY_API_HOST=0.0.0.0

# Health check hits the local API. wget is the smallest http client we have
# in Alpine; using it instead of node -e fetch() keeps startup faster and
# avoids loading the entire app to check liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --timeout=4 --spider \
    http://127.0.0.1:${HIVERELAY_API_PORT:-9100}/health || exit 1

# tini as PID 1 → graceful SIGTERM handling so shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/packages/core/cli/index.js"]

# Default: start a relay node. Override to run other subcommands, e.g.:
#   docker run ... p2p-hiverelay:latest help
CMD ["start"]
