# P2P Hiveswarm

**Always-on relay infrastructure for the Holepunch/Pear ecosystem.**

Pear apps are peer-to-peer — when the developer closes their laptop, the app goes offline. Hiveswarm fixes this. It provides a network of relay nodes that keep your app seeded, relay connections for NAT-blocked peers, and ensure your data stays available 24/7 — without servers, without accounts, without changing your code.

---

## Who Is This For?

### Pear App Developers
You've built a P2P app with Hyperdrive and Hyperswarm. It works great when you're online, but disappears when you're not. Hiveswarm gives your app always-on availability with **5 lines of code**.

### Relay Operators
You want to support the P2P ecosystem by running infrastructure. Hiveswarm nodes are lightweight (runs on a $5 VPS or Raspberry Pi), earn reputation through cryptographic proofs, and will support Lightning micropayments in Phase 2.

### Holepunch Ecosystem Projects
Keet, POS, and other Pear apps benefit from shared relay infrastructure. One relay node serves the entire ecosystem — not just one app.

---

## How It Works

```
Your Pear App
    │
    ├── publish()   → Creates a Hyperdrive, writes files, announces on DHT
    ├── seed()      → Asks relay nodes to replicate and serve your data
    └── open()      → Fetches data from any available peer (you, relays, other users)

Hiveswarm Relay Nodes
    │
    ├── Seed Protocol     → Accept seeding requests, replicate Hyperdrives
    ├── Circuit Relay     → Forward encrypted bytes between NAT-blocked peers
    ├── Proof-of-Relay    → Cryptographic challenges verify nodes are actually serving
    └── Discovery         → All nodes join a well-known DHT topic for automatic discovery
```

**The key insight**: relay nodes are just Hyperswarm peers. They join the same DHT, speak the same protocols, and replicate the same Hypercores. There's no separate network, no gateway, no proxy — just more peers that happen to be always online.

### Data Flow

1. **Developer publishes** — `app.publish()` creates a Hyperdrive, writes files, joins the DHT topic
2. **Relay nodes seed** — `app.seed()` broadcasts a signed request to connected relays; relays accept and begin replicating the Hyperdrive
3. **Developer goes offline** — The app is still available because relay nodes have a full copy
4. **End user opens the app** — `app.open(key)` finds peers on the DHT (relays + any other online peers) and replicates the data
5. **NAT-blocked users** — Circuit relay forwards encrypted bytes through a relay node when direct connections fail

### Security Model

- **End-to-end encrypted**: Relay nodes forward opaque bytes. They cannot read, modify, or inject content.
- **Signed seeding requests**: Only the key owner can request seeding. Relays verify signatures.
- **Proof-of-relay challenges**: Nodes prove they're actually serving data through cryptographic hash challenges. No proof = no reputation.
- **Bandwidth receipts**: Signed records of data transferred, used for accounting and reputation.
- **No trust required**: Verification is cryptographic, not social. A relay either passes challenges or it doesn't.

---

## Quick Start

### For App Developers (SDK)

```bash
npm install hiverelay
```

```js
import { HiveRelayClient } from 'hiverelay/client'

// Create a client (auto-creates Hyperswarm + Corestore)
const app = new HiveRelayClient('./my-app-storage')
await app.start()

// Publish content — returns a Hyperdrive
const drive = await app.publish([
  { path: '/index.html', content: '<h1>My P2P App</h1>' },
  { path: '/data.json', content: JSON.stringify({ version: 1 }) }
])

console.log('Share this key:', drive.key.toString('hex'))
// Your app is now seeded on relay nodes and available to anyone with the key
```

```js
// On another device — open and read
const app = new HiveRelayClient('./reader-storage')
await app.start()

const drive = await app.open('abc123...key')
const html = await app.get(drive.key, '/index.html')
const files = await app.list(drive.key, '/')
```

**That's it.** The SDK handles relay discovery, seeding negotiation, NAT traversal, and replication automatically. Your end user never sees relay infrastructure.

### For Relay Operators

```bash
git clone https://github.com/bigdestiny2/P2P-Hiveswarm
cd P2P-Hiveswarm
npm install

# Start a relay node
npx hiverelay start --region NA --max-storage 50GB

# Check status
npx hiverelay status

# Seed a specific app
npx hiverelay seed <app-key> --replicas 3
```

Or with Docker:

```bash
docker build -t hiveswarm .
docker run -d --name hiveswarm \
  -v hiveswarm-data:/data \
  -p 9100:9100 \
  hiveswarm
```

---

## SDK Reference

### Constructor

```js
// Simple mode — auto-creates everything
const app = new HiveRelayClient('./storage-path')

// Advanced mode — bring your own Hyperswarm/Corestore
const app = new HiveRelayClient({ swarm, store })

// With options
const app = new HiveRelayClient('./storage', {
  autoDiscover: true,    // Find relay nodes automatically (default: true)
  autoSeed: true,        // Seed published content on relays (default: true)
  seedReplicas: 3,       // Number of relay copies (default: 3)
  seedTimeout: 10000,    // Seed request timeout ms (default: 10000)
  maxRelays: 10,         // Max relay connections (default: 10)
})
```

### Content API

| Method | Description |
|--------|-------------|
| `app.publish(files, opts)` | Create a Hyperdrive, write files, seed on relays. Returns the drive. |
| `app.open(key, opts)` | Open a remote Hyperdrive by key. Replicates from any available peer. |
| `app.get(key, path)` | Read a file from an opened drive. Returns a Buffer. |
| `app.put(key, path, content)` | Write a file to an owned drive. |
| `app.list(key, dir)` | List files in a drive directory. |
| `app.closeDrive(key)` | Close a drive and leave its swarm topic. |

### Relay API

| Method | Description |
|--------|-------------|
| `app.seed(key, opts)` | Request relay nodes to seed a Hypercore/Hyperdrive. Returns acceptances. |
| `app.reserveRelay(relayPubKey)` | Reserve a circuit relay slot for NAT traversal. |
| `app.connectViaRelay(targetKey, relayKey)` | Connect to a peer through a relay (for NAT-blocked nodes). |
| `app.getRelays()` | List connected relay nodes and their capabilities. |
| `app.getSeedStatus(key)` | Check seeding status for an app key. |
| `app.getStatus()` | Get overall client status (relays, drives, connections). |

### Events

| Event | Data | Description |
|-------|------|-------------|
| `ready` / `started` | — | Client initialized |
| `published` | `{ key, files }` | Content published |
| `seeded` | `{ key, acceptances }` | Relays accepted seeding |
| `seed-error` | `{ key, error }` | Seeding failed |
| `relay-connected` | `{ pubkey }` | Connected to a relay node |
| `relay-disconnected` | `{ pubkey }` | Relay disconnected |
| `relay-reserved` | `{ relay }` | Circuit relay slot reserved |
| `destroyed` | — | Client shut down |

---

## Agent Integration

Hiveswarm relay nodes expose a **localhost HTTP API** designed for AI agent integration. Autonomous agents (like Hermes, OpenClaw, or custom bots) can query and control relay nodes without importing the module — just HTTP calls.

### API Endpoints for Agents

```bash
# Agent checks if relay is healthy
curl http://127.0.0.1:9100/health
# → { "ok": true, "running": true, "uptime": 3600 }

# Agent queries network status
curl http://127.0.0.1:9100/status
# → { "publicKey": "abc...", "connections": 12, "seededApps": 5, "relay": {...}, "seeder": {...} }

# Agent seeds a new app
curl -X POST http://127.0.0.1:9100/seed \
  -H 'Content-Type: application/json' \
  -d '{"appKey": "abc123..."}'
# → { "ok": true, "discoveryKey": "def456..." }

# Agent unseeds an app
curl -X POST http://127.0.0.1:9100/unseed \
  -H 'Content-Type: application/json' \
  -d '{"appKey": "abc123..."}'

# Agent reads connected peers
curl http://127.0.0.1:9100/peers
# → { "count": 8, "peers": [{ "remotePublicKey": "..." }, ...] }

# Agent scrapes Prometheus metrics
curl http://127.0.0.1:9100/metrics
# → hiverelay_connections_total 42\nhiverelay_bytes_relayed 1048576\n...
```

### Use Cases for Agents

- **Fleet management** — An agent monitors multiple relay nodes, seeds popular apps, and unseeds stale ones based on demand
- **Auto-scaling** — Agent watches connection counts and spins up new relay nodes when capacity is low
- **Revenue optimization** — Agent tracks bandwidth receipts and reputation scores to maximize earnings
- **Health monitoring** — Agent polls `/health` and `/metrics`, alerts on degradation, triggers restarts
- **Content curation** — Agent decides which Pear apps to seed based on popularity, region, or developer reputation

The API is localhost-only by default — agents must run on the same machine as the relay node. Rate limited to 60 req/min to prevent runaway agents from overwhelming the node.

---

## Reputation System

Relay operators earn reputation through **verifiable, cryptographic proof of service**. Reputation determines relay selection priority and (in Phase 2) payment rates.

### How Reputation Works

| Factor | Weight | Description |
|--------|--------|-------------|
| Proof-of-relay challenges | +10 pts/pass, -20 pts/fail | Random hash challenges prove the node actually holds data |
| Bandwidth served | +0.001 pts/MB | Verified via signed bandwidth receipts |
| Uptime | +1 pt/hour | Continuous DHT presence |
| Geographic diversity | +50 pts bonus | Bonus for underserved regions |
| Daily decay | x0.995/day | Scores decay ~0.5%/day without activity |

### Scoring Details

- **Challenge pass rate** = passed / total challenges. Relays must respond to random block hash challenges within 5 seconds.
- **Composite score** = `score * reliability * (1000 / avgLatencyMs)` — used for relay selection
- **Minimum ranking threshold** — 10+ challenges before a node appears on the leaderboard
- **Leaderboard** — Public ranked list of relay nodes by composite score, filterable by region
- **Relay selection** — When a developer requests seeding, the best relays are selected by composite score with optional geo-preference

### Held-Amount Schedule (Phase 2)

New relay operators have a portion of earnings held back to discourage hit-and-run behavior (Storj-inspired):

| Months Active | Held % |
|---------------|--------|
| 1-3 | 75% |
| 4-6 | 50% |
| 7-9 | 25% |
| 10+ | 0% |

Held amounts are returned after 15 months of good standing. Provably bad behavior (failed challenges, data corruption) triggers slashing of held funds.

### Payment Rates (Phase 2)

| Service | Rate |
|---------|------|
| Storage | 100 sats/GB/month |
| Bandwidth | 50 sats/GB transferred |
| Relay | 75 sats/GB relayed |
| Availability | 10 sats/hour guaranteed uptime |

---

## Features

### Seeding & Replication
- **Automatic relay discovery** — Clients find relay nodes via a well-known DHT topic
- **Signed seed requests** — Cryptographic proof of ownership before seeding
- **Configurable replicas** — Choose how many relay nodes seed your data (default: 3)
- **Eager download** — Relay nodes proactively download all drive content for fast serving
- **Hot updates** — Update your drive and relays pick up changes in <10ms

### Circuit Relay (NAT Traversal)
- **Bidirectional forwarding** — Encrypted bytes flow both directions with backpressure
- **Per-circuit limits** — Max 64MB and 10 minutes per circuit (configurable)
- **Capacity management** — Max 256 concurrent circuits per relay node
- **Clean teardown** — Circuits close on peer disconnect, timeout, or byte limit

### Proof-of-Relay
- **Hash challenges** — Relay nodes prove they hold data by responding to random block hash challenges
- **Challenge interval** — Every 5 minutes (configurable)
- **Latency threshold** — Must respond within 5 seconds or fail
- **Reputation impact** — Failed challenges reduce reputation score

### Reputation System
- **Score components** — Uptime, challenge pass rate, latency, bandwidth served
- **Daily decay** — Scores decay at 0.995/day to keep nodes active
- **Minimum threshold** — Nodes need 10+ challenges before being ranked
- **Public scores** — Clients can query reputation to choose better relays

### Incentive Layer (Phase 2)
- **Lightning micropayments** — LND integration for paying relay operators
- **Bandwidth receipts** — Signed proof of data transfer for accounting
- **Daily settlement** — Automatic settlement when balance exceeds threshold
- **Mock provider** — Development/testing without real Lightning node

### HTTP API (Operator)
- **`GET /health`** — Node health check
- **`GET /status`** — Stats: public key, connections, seeded apps, relay metrics
- **`GET /peers`** — Connected peers list
- **`GET /metrics`** — Prometheus-format metrics
- **`POST /seed`** — Seed an app by key
- **`POST /unseed`** — Stop seeding an app
- Rate limited: 60 req/min per IP, 64KB max body

### Transports
- **UDP (HyperDHT)** — Default, always on
- **WebSocket** — Browser peer support (Phase 2)
- **Tor** — Hidden service transport for censorship resistance (planned)
- **I2P** — Garlic routing for anonymity (planned)

### Production Ready
- **Structured logging** — JSON logs via pino, configurable via `HIVERELAY_LOG_LEVEL`
- **Crash protection** — Catches uncaught exceptions/rejections, logs, and exits cleanly
- **Docker** — Production Dockerfile with non-root user, healthcheck, volume mounts
- **systemd** — Service unit with security hardening (NoNewPrivileges, ProtectSystem)
- **CI/CD** — GitHub Actions: lint, unit tests, integration tests, security audit
- **Graceful shutdown** — Timeout-bounded cleanup of all subsystems

---

## Performance

Benchmarked on local testnet (3 DHT bootstrap nodes):

| Operation | Time |
|-----------|------|
| Start 3 relay nodes | 57ms |
| Discover relays | 29ms |
| Publish single file | 39ms |
| Replicate single file | 521ms |
| Publish 50 files | 82ms |
| Replicate 50 files | 652ms |
| Publish 1MB file | 15ms |
| Replicate 1MB file | 566ms |
| 5 concurrent publishers | 32ms |
| 5 concurrent consumers | 551ms |
| Read from relay (publisher offline) | 35ms |
| Hot update propagation | 7ms |
| API throughput | 1,553 req/s |

Real network latency adds ~200-500ms for DHT discovery. UDX (the UDP transport under HyperDHT) achieves 50-100MB/s per stream, 10-50MB/s through NAT traversal.

---

## Architecture

```
P2P-Hiveswarm/
├── client/                # SDK for Pear app developers
│   └── index.js           # HiveRelayClient — publish, open, seed, relay
├── core/
│   ├── relay-node/        # Relay daemon
│   │   ├── index.js       # RelayNode — main orchestrator
│   │   ├── relay.js       # Circuit relay with backpressure
│   │   ├── seeder.js      # Hypercore/Hyperdrive seeder
│   │   ├── api.js         # HTTP API (localhost only)
│   │   └── metrics.js     # Prometheus metrics collector
│   ├── protocol/          # Wire protocol (Protomux)
│   │   ├── messages.js    # Compact-encoded message schemas
│   │   ├── seed-request.js    # Seed request/accept protocol
│   │   ├── relay-circuit.js   # Circuit relay protocol
│   │   ├── proof-of-relay.js  # Cryptographic proof challenges
│   │   └── bandwidth-receipt.js # Signed bandwidth proofs
│   ├── registry/          # Autobase seeding registry
│   └── logger.js          # Structured logging (pino)
├── incentive/
│   ├── payment/           # Lightning micropayments
│   │   ├── index.js       # PaymentManager (ledger + settlement)
│   │   ├── lightning-provider.js  # LND gRPC client
│   │   └── mock-provider.js      # Mock for testing
│   └── reputation/        # Reputation scoring
├── transports/
│   └── websocket/         # WebSocket transport (browser peers)
├── cli/                   # CLI tool
├── config/                # Default configuration
├── test/
│   ├── unit/              # 71 unit tests
│   └── integration/       # 15 integration tests
├── scripts/               # Benchmarks and test scenarios
├── Dockerfile             # Production container
├── docker-compose.yml     # Docker Compose config
├── hiverelay.service      # systemd unit file
└── PRODUCTION.md          # Operator deployment guide
```

---

## Running Tests

```bash
npm test                   # All tests (86 tests, 253 assertions)
npm run test:unit          # Unit tests only
npm run test:integration   # Integration tests (requires network)
npm run lint               # Linting (standardjs)

# Comprehensive benchmarks
node scripts/comprehensive-test.js

# POS app simulation
node scripts/pear-pos-test.js
```

---

## Configuration

All options in `config/default.js`:

```js
{
  storage: './hiverelay-storage',
  maxConnections: 256,
  maxStorageBytes: '50 GB',

  // Seeding
  enableSeeding: true,
  announceInterval: '15 min',

  // Circuit Relay
  enableRelay: true,
  maxRelayBandwidthMbps: 100,
  maxCircuitDuration: '10 min',
  maxCircuitBytes: '64 MB',

  // API & Metrics
  enableAPI: true,
  apiPort: 9100,
  enableMetrics: true,

  // Transports
  transports: { udp: true, websocket: false, tor: false, i2p: false },

  // Lightning (Phase 2)
  lightning: { enabled: false, rpcUrl: 'localhost:10009' },
  payment: { enabled: false, settlementInterval: '24h', minSettlementSats: 1000 }
}
```

Environment variables:
- `HIVERELAY_LOG_LEVEL` — `trace`, `debug`, `info` (default), `warn`, `error`, `fatal`

---

## Roadmap

**Phase 1: Community Relay Network** (current)
- No token, no payments
- Operators earn reputation through proof-of-relay
- SDK available for Pear app developers

**Phase 2: Incentive Layer**
- Lightning micropayments for relay operators
- WebSocket transport for browser peers
- Bandwidth marketplace

**Phase 3: Scale**
- Tor/I2P transports
- Cross-region relay routing
- Token-based incentives (if demand proves it)

---

## Design Principles

1. **Hyperswarm-native** — Built on the same stack as Pear apps. Not a separate network.
2. **Invisible infrastructure** — End users never see relay nodes. The developer experience is `publish()` and `open()`.
3. **Cross-app peer sharing** — One relay node serves the entire Pear ecosystem.
4. **Low barrier** — Runs on a $5/month VPS or Raspberry Pi.
5. **No blockchain for blockchain's sake** — Token phase only if real demand proves it necessary.
6. **Privacy by default** — Relays see encrypted bytes only.

---

## License

[Apache 2.0](LICENSE)
