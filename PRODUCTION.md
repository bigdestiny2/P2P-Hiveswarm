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

The HTTP API binds to `127.0.0.1` only. It is not accessible from the network by default.

If you need remote access (e.g., for Prometheus scraping from another host), use a reverse proxy with authentication:

```nginx
# /etc/nginx/sites-available/hiverelay
server {
    listen 9100 ssl;
    server_name your-server.example.com;

    ssl_certificate /etc/letsencrypt/live/your-server.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-server.example.com/privkey.pem;

    # Only allow metrics and health (read-only)
    location /metrics {
        proxy_pass http://127.0.0.1:9100;
    }

    location /health {
        proxy_pass http://127.0.0.1:9100;
    }

    # Block write endpoints from remote access
    location /seed { return 403; }
    location /unseed { return 403; }
}
```

The API has built-in rate limiting (60 requests/minute per IP).

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
