---
name: hiverelay
description: Operate a HiveRelay P2P relay node — start/stop the daemon, seed Pear apps, monitor health, check peers and metrics
version: 1.0.0
metadata:
  hermes:
    tags: [p2p, infrastructure, relay, hyperswarm]
    category: devops
  openclaw:
    tags: [p2p, infrastructure, relay, hyperswarm]
    category: devops
---

# HiveRelay — P2P Relay Node Operator

You are operating a HiveRelay node — a decentralized P2P relay backbone for the Holepunch/Pear ecosystem. HiveRelay seeds Pear apps (keeps them alive when publishers are offline), relays connections for NAT-challenged peers, and earns reputation through cryptographic proof-of-relay challenges.

## Prerequisites

HiveRelay must be initialized first. If not already done:

```bash
npx hiverelay init
```

This creates `~/.hiverelay/config.json`, storage at `~/.hiverelay/storage/`, and installs this skill.

## Commands

### /hiverelay start

Start the relay node daemon. It runs in the foreground and exposes an HTTP API on port 9100.

```bash
hiverelay start
```

With options:
```bash
hiverelay start --region NA --max-storage 100GB --port 9100
```

After starting, verify it's running:
```bash
curl -s http://127.0.0.1:9100/health | jq .
```

Expected response: `{"ok": true, "running": true, "uptime": {...}}`

To run in the background:
```bash
nohup hiverelay start --quiet > ~/.hiverelay/relay.log 2>&1 &
echo $! > ~/.hiverelay/relay.pid
```

### /hiverelay stop

Stop a running relay node.

If running in foreground: send Ctrl+C (graceful shutdown via SIGINT).

If running in background:
```bash
kill $(cat ~/.hiverelay/relay.pid 2>/dev/null) 2>/dev/null && rm ~/.hiverelay/relay.pid
```

### /hiverelay status

Query the running node for live stats.

```bash
curl -s http://127.0.0.1:9100/status | jq .
```

Interpret the response:
- `running` — is the node active
- `publicKey` — this node's identity on the DHT
- `seededApps` — number of Pear apps being seeded
- `connections` — active peer connections
- `seeder.totalBytesStored` — total data stored
- `seeder.totalBytesServed` — total data served to peers
- `relay.activeCircuits` — live relay circuits
- `relay.totalBytesRelayed` — total bytes forwarded

If the node is not running, you'll get a connection refused error. Start it first.

### /hiverelay seed <key>

Seed a Pear app by its hex key. The relay will download and persistently serve its Hypercores.

```bash
curl -s -X POST http://127.0.0.1:9100/seed \
  -H 'Content-Type: application/json' \
  -d '{"appKey": "<64-char-hex-key>"}' | jq .
```

The appKey must be exactly 64 hexadecimal characters. On success, returns `{"ok": true, "discoveryKey": "..."}`.

Via CLI (requires the node to not be running — starts a new node with seed):
```bash
hiverelay start --seed <key>
```

### /hiverelay health

Run a full health check on the relay node.

```bash
# 1. Check API is responding
curl -sf http://127.0.0.1:9100/health | jq .

# 2. Check process is alive
pgrep -f 'hiverelay start' > /dev/null && echo "Process: running" || echo "Process: not running"

# 3. Check storage usage
du -sh ~/.hiverelay/storage/ 2>/dev/null || echo "No storage directory"

# 4. Check peer connections
curl -s http://127.0.0.1:9100/status | jq '{connections: .connections, seededApps: .seededApps, circuits: .relay.activeCircuits}'
```

Report all results to the user. If any check fails, suggest remediation.

### /hiverelay peers

List connected peers.

```bash
curl -s http://127.0.0.1:9100/peers | jq .
```

Returns `{"count": N, "peers": [{"remotePublicKey": "hex..."}]}`.

### /hiverelay metrics

Export Prometheus-formatted metrics for monitoring.

```bash
curl -s http://127.0.0.1:9100/metrics
```

Returns plain text in Prometheus exposition format. Key metrics:
- `hiverelay_uptime_seconds` — node uptime
- `hiverelay_connections` — active peers
- `hiverelay_bytes_served` — total bandwidth served
- `hiverelay_active_circuits` — live relay circuits
- `hiverelay_errors_total` — connection error count
- `hiverelay_process_heap_bytes` — memory usage

## API Reference

The relay node exposes a local HTTP API on `http://127.0.0.1:9100` (configurable with `--port`).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check with uptime |
| GET | `/status` | Full node statistics |
| GET | `/metrics` | Prometheus metrics (text/plain) |
| GET | `/peers` | Connected peer list |
| POST | `/seed` | Seed an app `{"appKey": "hex"}` |
| POST | `/unseed` | Stop seeding `{"appKey": "hex"}` |

## Troubleshooting

- **"Connection refused"** — Node is not running. Start with `hiverelay start`.
- **"EADDRINUSE"** — Port 9100 is taken. Use `--port 9101` or kill the existing process.
- **"Invalid app key"** — Key must be exactly 64 hex characters (0-9, a-f).
- **Node exits immediately** — Check `~/.hiverelay/relay.log` for errors. Usually a storage permission issue.
