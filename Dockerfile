FROM node:22-slim

LABEL maintainer="hiverelay"
LABEL description="HiveRelay — P2P relay backbone for the Holepunch/Pear ecosystem"

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application
COPY . .

# Storage volume
VOLUME /data

# API port (localhost only by default, expose for health checks)
EXPOSE 9100

# Environment
ENV NODE_ENV=production
ENV HIVERELAY_LOG_LEVEL=info

# Run as non-root
RUN groupadd -r hiverelay && useradd -r -g hiverelay -d /data hiverelay
RUN chown -R hiverelay:hiverelay /app /data
USER hiverelay

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:9100/health').then(r=>r.json()).then(d=>{if(!d.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "cli/index.js"]
CMD ["start", "--storage", "/data"]
