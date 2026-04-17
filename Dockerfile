# syntax=docker/dockerfile:1.6
#
# p2p-hiverelay — P2P relay backbone for the Holepunch/Pear ecosystem.
#
# Multi-stage build:
#   Stage 1 (deps):    install production deps only (layer-cached)
#   Stage 2 (runtime): minimal runtime image with non-root user
#
# Build:
#   docker build -t p2p-hiverelay:latest .
#
# Quick run (data volume + API port published):
#   docker run -d --name hiverelay \
#     -v hiverelay-data:/data \
#     -p 9100:9100 \
#     p2p-hiverelay:latest
#
# Open the TUI (connects to the running container's API):
#   docker exec -it hiverelay p2p-hiverelay tui
#
# Environment overrides:
#   HIVERELAY_REGION=NA           (region code)
#   HIVERELAY_MAX_STORAGE=50GB    (accepts human-readable sizes)
#   HIVERELAY_API_KEY=...         (secures management endpoints)
#   HIVERELAY_PORT=9100           (API port inside container)
#   HIVERELAY_HOLESAIL=1          (enable Holesail for NAT traversal)

# ─── Stage 1: dependencies ────────────────────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app

# Install only what npm ci needs (package-lock.json is the source of truth)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force

# ─── Stage 2: runtime ─────────────────────────────────────────────────
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.title="p2p-hiverelay"
LABEL org.opencontainers.image.description="Always-on P2P relay infrastructure for the Holepunch/Pear ecosystem"
LABEL org.opencontainers.image.source="https://github.com/bigdestiny2/P2P-Hiverelay"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# tini gives us proper PID 1 signal handling for graceful shutdown
RUN apt-get update && \
    apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Bring in already-installed modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (respects .dockerignore)
COPY . .

# Non-root user for security
RUN groupadd -r hiverelay && \
    useradd -r -g hiverelay -d /data -s /usr/sbin/nologin hiverelay && \
    mkdir -p /data /config && \
    chown -R hiverelay:hiverelay /app /data /config

# Make the p2p-hiverelay binary globally callable inside the container,
# so `docker exec -it hiverelay p2p-hiverelay tui` just works.
RUN ln -s /app/cli/index.js /usr/local/bin/p2p-hiverelay && \
    ln -s /app/cli/index.js /usr/local/bin/hiverelay && \
    chmod +x /app/cli/index.js

USER hiverelay

VOLUME ["/data", "/config"]

# API port. Gateway (9200) and other transport ports may need their own
# `-p` mappings when you enable them.
EXPOSE 9100

ENV NODE_ENV=production \
    HIVERELAY_STORAGE=/data \
    HIVERELAY_CONFIG_DIR=/config \
    HIVERELAY_LOG_LEVEL=info \
    HIVERELAY_PORT=9100

# Health check hits the local API — uses fetch() so no extra deps needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HIVERELAY_PORT||9100)+'/health').then(r=>r.json()).then(d=>{if(!d.ok)process.exit(1)}).catch(()=>process.exit(1))"

# tini as PID 1 → graceful SIGTERM handling so shutdown actually runs
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/cli/index.js"]

# Default: start a relay node. Override to run other subcommands, e.g.:
#   docker run ... p2p-hiverelay:latest testnet
#   docker run ... p2p-hiverelay:latest help
CMD ["start"]
