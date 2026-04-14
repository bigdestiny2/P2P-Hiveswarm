# HiveRelay — Project Status

**Version 0.3.0** | **Last verified: April 2026** | **Network: 5 relays, 2 regions (NA, APAC)**

---

## What HiveRelay Is

Relay infrastructure for the Holepunch/Hyperswarm ecosystem. Developers publish P2P apps that stay online after they close their laptop. Operators run relay nodes and earn from the traffic.

No blockchain. No token. Lightning micropayments when you want them, reputation-only when you don't.

---

## What's Live Right Now

Five relay nodes running in production across two continents, including one home relay behind NAT:

| Node | Region | Specs | Status |
|------|--------|-------|--------|
| Utah | NA | 0.5 GB RAM, 20 GB disk | Healthy |
| Utah-US | NA | 2 GB RAM, 60 GB disk | Healthy |
| Singapore | APAC | 1 GB RAM, 25 GB disk | Healthy |
| Singapore-2 | APAC | 1 GB RAM, 65 GB disk | Healthy |
| Mac Mini (HomeHive) | NA | 64 GB RAM, local | Healthy (via Holesail tunnel) |

All nodes auto-discover each other via Hyperswarm DHT, sync their app catalogs automatically, and share health state. The Mac Mini runs behind NAT and connects to the network via Holesail transport — VPS relays discover it through DHT, exchange metadata over Protomux, and probe its API through the Holesail tunnel.

---

## Verified Capabilities

Everything below has been tested end-to-end against the live network (179 integration tests, all passing).

### For Developers

**Publish an app in 4 lines:**

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'
const client = new HiveRelayClient({ storage: './my-storage' })
await client.start()
const drive = await client.publish('./my-app')
```

Accepts a directory path — reads all files recursively, writes them to an encrypted Hyperdrive, and replicates to relay nodes. Also accepts `[{ path, content }]` arrays for programmatic use.

**What works today:**

- **Publish + Seed** — publish a directory or file set, relay nodes store and serve it within seconds
- **Always-on availability** — close your laptop, your app is still live on 5 relays
- **Blind/encrypted mode** — relay stores ciphertext only, content readable only by peers with the encryption key
- **Gateway serving** — any seeded app accessible via HTTP at `relay:9100/v1/hyper/{driveKey}/path`
- **20 service routes** via unified dispatch — AI inference, compute, storage, identity, schemas, SLAs
- **Real-time events** — SSE subscriptions for seeding, connections, health changes
- **Cross-app interoperability** — schema registry for shared data formats
- **NAT traversal** — circuit relay bridges NAT-blocked peers through encrypted tunnels
- **Holesail transport** — home/NAT relays tunnel their API through Holesail so VPS relays can probe and display them on the network dashboard
- **Developer unseed (kill switch)** — developers can remotely unseed their apps across all relays with a signed request (Ed25519 signature verification, 5-minute replay window)
- **Cross-relay catalog sync** — new relays automatically pull all existing apps from the network within seconds of connecting
- **Pear Runtime native** — runs in Pear terminal apps via bare-events/bare-fs/bare-path, 11/11 tests passing

**Client SDK methods:**

| Method | What It Does |
|--------|-------------|
| `publish(dir)` | Publish a directory to a Hyperdrive |
| `publish([{path, content}])` | Publish explicit files |
| `open(key)` | Open and replicate a remote drive |
| `get(key, path)` | Read a file from a drive |
| `put(key, path, content)` | Write a file to a drive |
| `list(key, path)` | List directory contents |
| `seed(key, opts)` | Request relay nodes to persist your data |
| `unseed(key)` | Remotely kill/unseed your app from all relays (signed) |
| `reserveRelay()` | Reserve a circuit relay slot for NAT traversal |
| `connectViaRelay(peer)` | Connect to a peer through a relay |
| `callService(svc, method, params)` | Call any service on a relay over P2P |
| `getServiceCatalog()` | Get available services from connected relays |

### For Operators

**Start with the interactive setup wizard:**

```bash
npx p2p-hiverelay setup     # Interactive TUI — profiles, services, transports
npx p2p-hiverelay start     # Or quick start with defaults
```

Node auto-discovers the network, starts seeding apps, and begins serving traffic.

**Live management console** — adjust everything at runtime without restarts:

```bash
hiverelay manage             # Full interactive TUI
```

**6 operating modes:** Standard, HomeHive (home/personal), Seed-Only, Relay-Only, Stealth (Tor-only), Gateway (HTTP focus). Switch live via TUI or API.

**What operators get:**

- **Automatic app seeding** — catalog sync pulls apps from other relays
- **Unified AppRegistry** — single source of truth for all app types (P2P, blind, HTTP)
- **Credit system** — 1,000 welcome sats per new app, volume bonuses at 10K/50K/100K thresholds
- **Metering** — every dispatch call tracked, billed per route at published rates
- **Health monitoring** — 5 checks (memory, connections, swarm, errors, disk) every 30 seconds
- **Self-healing** — GC on memory pressure, stale connection cleanup, cache clearing, auto-restart (max 3/hour)
- **Prometheus metrics** — `relay:9100/metrics` for Grafana/alerting
- **Dashboard** — real-time web UI at `relay:9100/dashboard` with network map, earnings calculator, payment history
- **Management API** — 10 endpoints for programmatic config, service, transport, and mode control

**Operator economics (current rate card):**

| Service | Rate |
|---------|------|
| AI inference | 1 sat/1K input tokens, 2 sats/1K output tokens |
| Compute jobs | 5 sats/job |
| Storage write | 2 sats/write |
| Storage read | 1 sat/read |
| Identity ops | 1 sat/operation |
| Schema ops | 1 sat/operation |

Revenue splits: 75% held for first 3 months (decreasing to 0% at month 10) to incentivize long-term operation.

### Privacy / Blind Mode

Apps can publish in encrypted mode where relay nodes store and replicate data but cannot read it:

```js
const drive = await client.publish('./my-app', {
  encryptionKey: myKey  // 32-byte key — only you and authorized peers can decrypt
})
```

- Relay stores opaque ciphertext blocks
- HTTP gateway returns 403 for blind apps ("P2P access only")
- Authorized peers connect directly via Hyperswarm with the encryption key
- Circuit relay bridges encrypted streams without decryption — relay sees only bytes
- Catalog lists the app for discovery (name, key) but content is inaccessible

### Services Layer

20 routes across 6 services, all accessible via HTTP dispatch **and P2P `callService()`**:

```js
// P2P service calls — no HTTP needed
const result = await client.callService('identity', 'whoami')
const models = await client.callService('ai', 'list-models')
const answer = await client.callService('ai', 'infer', { modelId: 'gemma4:latest', input: 'What is 2+2?' })
```

P2P service latency: **~260ms** avg across relay network. Service catalog and app catalog pushed to clients on connect.

| Service | Routes | Status |
|---------|--------|--------|
| AI Inference | `ai.infer`, `ai.embed`, `ai.list-models`, `ai.status` | Fully operational with Ollama (tested: gemma4) |
| Compute | `compute.submit`, `compute.status`, `compute.result` | Registered, JS sandbox ready |
| Storage | `storage.drive-create`, `drive-list`, `drive-read`, `drive-write` | Fully operational |
| Identity | `identity.whoami`, `identity.sign`, `identity.verify` | Fully operational |
| Schema | `schema.register`, `schema.list`, `schema.validate` | Fully operational |
| SLA | `sla.create`, `sla.get`, `sla.list` | Registered, contract tracking live |

### Credit & Payment Pipeline

- **Wallets** — auto-created per app key, 1,000 welcome credits
- **Top-up** — API endpoint for adding credits
- **Metering** — every service call deducts from wallet at rate card prices
- **Tier system** — free (rate-limited), standard (2M calls), unlimited (whitelisted)
- **Freeze/unfreeze** — admin controls for abuse prevention
- **Invoice system** — Lightning invoice generation (when backend configured)
- **Cross-relay independence** — credits are per-relay, not shared

### Identity System

- **LNURL-auth** — passwordless login via Lightning wallet (LUD-04)
- **Attestations** — Schnorr signatures binding developer keys to app keys
- **Developer registry** — profile management, app key tracking
- **Session management** — token-based auth with proper 401 handling
- **Cross-relay sync** — identity data propagates across all nodes

---

## What's Not Done Yet

Honest accounting of gaps:

| Area | Status | What's Missing |
|------|--------|---------------|
| AI embeddings | Inference works (Ollama/gemma4) | Embedding models not tested yet (gemma4 doesn't support them) |
| Compute sandbox | JS `vm` handler ready | No container/WASM isolation for untrusted code |
| Lightning payments | Invoice creation works | No LND/CLN backend connected for settlement |
| ZK proofs | Service designed | Not implemented |
| Token model | Economics documented | No token — intentionally deferred |
| Mobile | Architecture supports it | No mobile testing |

---

## Test Coverage

179 integration tests against the live 5-server network, all passing:

| Suite | Tests | What It Covers |
|-------|-------|----------------|
| Router | 37 | Dispatch to all services, cross-relay consistency, latency, error handling, concurrent load |
| Circuit Relay | 19 | Stats, config, bandwidth receipts, capacity, Prometheus metrics, health |
| Gateway | 19 | File serving, security (path traversal, null bytes), content types, concurrent access, cross-relay |
| Credits | 22 | Pricing, wallets, metering, quotas, freeze/unfreeze, grants, invoices |
| Identity | 18 | LNURL-auth, attestations, sessions, dispatch, cross-relay sync |
| Health | 26 | Memory, connections, disk, errors, self-heal, uptime, reputation |
| Blind Mode | 12 | Encrypted publish, gateway rejection, P2P access, cross-relay sync, E2E flow |
| P2P Services | 15 | callService over Hyperswarm, catalog exchange, concurrent calls, error handling, latency |
| Pear Runtime | 11 | Native Bare runtime import, publish dir/array, relay discovery, callService, blind mode, cleanup |

---

## Install

```bash
# Developers — SDK for building apps
npm install p2p-hiverelay

# Operators — run a relay node
hiverelay setup     # Interactive setup wizard
hiverelay start     # Start the node
hiverelay manage    # Live management console
```

---

## Architecture at a Glance

```
Developer App
    │
    ├─ publish('./my-app')  ──→  Hyperdrive (encrypted or plain)
    │                                │
    │                         Hyperswarm DHT
    │                    ╱     ╱     │     ╲     ╲
    │              Utah  Utah-US  Singapore  Singapore-2
    │              Relay  Relay    Relay       Relay
    │                │      │        │          │
    │                └───── Catalog Sync ───────┘
    │                               │
    │                    Mac Mini (HomeHive)
    │                    behind NAT ── Holesail tunnel ──→ VPS relays
    │
    ├─ client.get(key, path) ←── P2P replication
    │
    ├─ client.unseed(key)   ──→  Signed kill switch → all relays
    │
    └─ HTTP gateway  ──→  relay:9100/v1/hyper/{key}/path
```

Blind mode: same flow, but drives are encrypted. Gateway returns 403. Peers need the encryption key to read.

Holesail transport: home relays behind NAT use Holesail to tunnel their API to the public network. VPS relays discover them via DHT, exchange holesail keys over Protomux, and probe through the tunnel.

---

## Links

- **Dashboard**: `http://{relay}:9100/dashboard`
- **Docs**: `http://{relay}:9100/dashboard/docs.html`
- **Health**: `http://{relay}:9100/health`
- **Catalog**: `http://{relay}:9100/catalog.json`
- **Metrics**: `http://{relay}:9100/metrics`
- **npm**: [p2p-hiverelay](https://www.npmjs.com/package/p2p-hiverelay)
