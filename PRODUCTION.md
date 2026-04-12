# HiveRelay Production Deployment Guide

## Prerequisites

- Node.js >= 20
- A server with a public IP (VPS, dedicated, or cloud instance)
- UDP port access (HyperDHT uses UDP for peer discovery)
- At least 1 GB RAM, 10 GB disk (more disk = more apps you can seed)

## Option 1: Bare Metal / VPS

### Install

```bash
git clone https://github.com/hiverelay/hiverelay.git /opt/hiverelay
cd /opt/hiverelay
npm ci --omit=dev
```

### Create system user

```bash
sudo useradd -r -s /usr/sbin/nologin -d /var/lib/hiverelay hiverelay
sudo mkdir -p /var/lib/hiverelay
sudo chown hiverelay:hiverelay /var/lib/hiverelay
```

### Configure

```bash
# Create config (optional — defaults work fine)
sudo -u hiverelay mkdir -p /var/lib/hiverelay
cat <<EOF | sudo tee /home/hiverelay/.hiverelay/config.json
{
  "storage": "/var/lib/hiverelay",
  "maxStorageBytes": 53687091200,
  "regions": ["NA"],
  "apiPort": 9100,
  "enableRelay": true,
  "enableSeeding": true,
  "enableMetrics": true,
  "enableAPI": true
}
EOF
```

### Install systemd service

```bash
sudo cp /opt/hiverelay/hiverelay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable hiverelay
sudo systemctl start hiverelay
```

### Verify

```bash
sudo systemctl status hiverelay
journalctl -u hiverelay -f          # Follow logs
curl http://127.0.0.1:9100/health   # Health check
curl http://127.0.0.1:9100/status   # Full status
```

## Option 2: Docker

### Quick start

```bash
docker run -d \
  --name hiverelay \
  --restart unless-stopped \
  -v hiverelay-data:/data \
  -p 9100:9100 \
  hiverelay/hiverelay:latest \
  start --storage /data --region NA
```

### With docker-compose

```bash
cd /opt/hiverelay
docker compose up -d
docker compose logs -f
```

### Host networking (recommended for best DHT performance)

```bash
docker run -d \
  --name hiverelay \
  --restart unless-stopped \
  --network host \
  -v hiverelay-data:/data \
  hiverelay/hiverelay:latest \
  start --storage /data
```

Host networking gives HyperDHT direct UDP access without NAT translation, which improves peer discovery and hole-punching reliability.

## Logging

HiveRelay uses structured JSON logging via pino.

### Log levels

Set via environment variable:

```bash
HIVERELAY_LOG_LEVEL=info    # Default: info
HIVERELAY_LOG_LEVEL=debug   # Verbose (development)
HIVERELAY_LOG_LEVEL=warn    # Quiet (production)
```

### View logs

```bash
# systemd
journalctl -u hiverelay -f
journalctl -u hiverelay --since "1 hour ago"

# Docker
docker logs -f hiverelay

# Pretty-print (install pino-pretty globally)
journalctl -u hiverelay -o cat | npx pino-pretty
```

### Log rotation (systemd)

journald handles rotation automatically. To configure retention:

```bash
sudo vi /etc/systemd/journald.conf
# SystemMaxUse=500M
# MaxRetentionSec=30day
sudo systemctl restart systemd-journald
```

## Monitoring

### Prometheus

Scrape `http://localhost:9100/metrics` from your Prometheus instance:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: hiverelay
    static_configs:
      - targets: ['your-server:9100']
    scrape_interval: 30s
```

Available metrics:
- `hiverelay_uptime_seconds` — Node uptime
- `hiverelay_seeded_apps` — Number of apps being seeded
- `hiverelay_bytes_stored` — Total bytes stored
- `hiverelay_bytes_served` — Total bytes served to peers
- `hiverelay_connections` — Current active connections
- `hiverelay_active_circuits` — Active relay circuits
- `hiverelay_process_heap_bytes` — V8 heap usage
- `hiverelay_process_rss_bytes` — Resident set size

### Health checks

```bash
# Simple health check (for load balancers, uptime monitors)
curl -f http://127.0.0.1:9100/health

# Full status
curl http://127.0.0.1:9100/status

# Peer list
curl http://127.0.0.1:9100/peers
```

## API Security

The HTTP API binds to `0.0.0.0` by default for remote access compatibility (relays are public infrastructure). To restrict to localhost, set `apiHost: '127.0.0.1'` in config.

### TLS with Caddy (Recommended)

Caddy provides automatic HTTPS with Let's Encrypt certificates:

```bash
# Install Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy

# Configure
sudo tee /etc/caddy/Caddyfile <<'EOF'
relay-us.p2phiverelay.xyz {
    reverse_proxy 127.0.0.1:9100

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
}
EOF

sudo systemctl enable caddy
sudo systemctl restart caddy
```

Caddy auto-obtains and renews TLS certificates. No manual cert management needed.

### TLS with NGINX (Alternative)

```nginx
server {
    listen 443 ssl http2;
    server_name relay.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:9100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### API Authentication (Optional — Private Relays)

For private relay operators who want to restrict who can seed:

```bash
# Generate and set API key
export HIVERELAY_API_KEY=$(openssl rand -hex 32)
# Add to systemd: Environment=HIVERELAY_API_KEY=<key>
```

When `HIVERELAY_API_KEY` is set:
- All write endpoints (`POST /seed`, `/unseed`, `/registry/*`) require `Authorization: Bearer <key>` header
- Read endpoints remain open (health, metrics, catalog, gateway)
- Ownership signatures and registration challenges become available (opt-in, verified when provided)

**Note:** Public relays (like the official HiveRelay network) do NOT use API keys. Relays are open infrastructure — anyone can seed. Rate limiting and storage limits prevent abuse.

### Rate Limiting

Built-in rate limiting protects against abuse:
- **HTTP API**: 60 requests/minute per IP, 64KB max request body
- **P2P Protocol**: Token bucket rate limiter per peer key
- **Directory listings**: Max 1000 entries with timeout protection

## Firewall

HiveRelay needs outbound UDP for HyperDHT. No specific inbound ports need to be opened — HyperDHT handles NAT traversal automatically.

```bash
# If you want to explicitly allow (optional, usually not needed):
# UDP — HyperDHT (ephemeral ports)
sudo ufw allow out proto udp

# API — only if exposing via reverse proxy
sudo ufw allow 9100/tcp
```

## Storage Management

Default max storage: 50 GB. Configure with `--max-storage`:

```bash
hiverelay start --max-storage 100GB
```

Monitor disk usage:

```bash
curl http://127.0.0.1:9100/status | jq '.seeder.totalBytesStored'
du -sh /var/lib/hiverelay
```

The relay node tracks storage per-core and will reject new seed requests when approaching the limit.

## Scaling

### Vertical

Increase `--max-connections` (default 256) and `--max-storage`. A single node can handle hundreds of concurrent peers.

### Horizontal

Run multiple relay nodes on different machines. They discover each other automatically via the DHT — no coordination needed. Each node independently:
- Announces on the discovery topic
- Accepts seed requests based on local capacity
- Responds to proof-of-relay challenges

### Resource guidelines

| Workload | RAM | Disk | CPU | Connections |
|----------|-----|------|-----|-------------|
| Light (< 10 apps) | 512 MB | 10 GB | 1 core | 64 |
| Medium (10-50 apps) | 1 GB | 50 GB | 2 cores | 256 |
| Heavy (50+ apps) | 2 GB | 200 GB | 4 cores | 512 |

## Updating

```bash
# Bare metal
cd /opt/hiverelay
git pull
npm ci --omit=dev
sudo systemctl restart hiverelay

# Docker
docker compose pull
docker compose up -d
```

## Troubleshooting

### Node won't start

```bash
# Check logs
journalctl -u hiverelay --no-pager -n 50

# Check port conflict
ss -tlnp | grep 9100

# Check storage permissions
ls -la /var/lib/hiverelay
```

### No peers connecting

```bash
# Check DHT connectivity
curl http://127.0.0.1:9100/peers

# Check if UDP is blocked
# HyperDHT needs outbound UDP access
```

### High memory usage

```bash
# Check metrics
curl http://127.0.0.1:9100/metrics | grep process

# Reduce connections
hiverelay start --max-connections 128

# systemd will enforce MemoryMax=2G and restart if exceeded
```

### Apps not appearing in catalog

If you seed apps but they don't show in `/catalog.json`:

1. **Check manifest.json exists** — Apps MUST have a `/manifest.json` file in their root:
   ```json
   {
     "id": "my-app",
     "name": "My App",
     "description": "App description",
     "version": "1.0.0",
     "categories": ["utility"]
   }
   ```

2. **Convert Pear keys correctly** — Pear uses z-base-32 encoding, but the API expects hex:
   ```javascript
   // Convert pear://KEY to hex
   const z32 = require('z32')
   const hexKey = z32.decode('om5cpdjjp4g4wa15r9wjhjiex9jjmcsacwsw44hzsrtsz171ykfy').toString('hex')
   // Result: 82f6c68d296e8daa625b27e89e26a87fd295b2d8652d4d6b97b1236bcbb2028a
   ```

3. **Check gateway can access drive** — The relay must be able to replicate the drive:
   ```bash
   # Test gateway access
   curl http://localhost:9100/v1/hyper/HEX_KEY/manifest.json
   ```

### TLS/HTTPS issues

**Problem:** Caddy fails to obtain certificates or shows certificate errors.

**Check domain configuration:**
```bash
# Verify DNS resolves to this server
dig +short relay-us.p2phiverelay.xyz

# Check Caddy is using correct domain (NOT p2p-hiverelay.xyz with hyphen)
cat /etc/caddy/Caddyfile | grep -E "^\w+\.p2p"
```

**Common fixes:**
- Ensure domain in Caddyfile matches DNS (use `p2phiverelay.xyz` not `p2p-hiverelay.xyz`)
- Clear Caddy's certificate cache if switching from staging: `rm -rf ~/.local/share/caddy/certificates`
- Check rate limits: Let's Encrypt allows 50 certificates per domain per week

## App Deployment Checklist

When deploying Pear apps to HiveRelay:

- [ ] App has `manifest.json` with id, name, description, version
- [ ] App is staged with `pear stage dev .`
- [ ] Pear key is converted from z-base-32 to hex format
- [ ] App is seeded via `POST /seed {"appKey": "hex", "appId": "..."}`
- [ ] Verify with `GET /catalog.json` — app should appear within 5 seconds
- [ ] Test app loads via `GET /v1/hyper/HEX_KEY/index.html`
