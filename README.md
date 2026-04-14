# HiveRelay

**Always-on relay infrastructure for the Pear & Hyperswarm ecosystem.**

> **Live and free to use now.** 3 relay nodes running across NA and APAC — all services are open for developers to experiment with. Just `npm install p2p-hiverelay` and start building.

---

## The Problem

You build a P2P app on Hyperswarm. It works beautifully — until you close your laptop. Then your users see "offline" and your app is dead. Mobile users behind carrier NATs can't connect at all. Browser users can't use UDP. There's no persistence, no discovery, no services backend.

## The Fix

HiveRelay gives your app always-on availability, NAT traversal, browser access, app discovery, AI inference, identity, and a services layer — without running your own servers.

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'
const app = new HiveRelayClient('./my-app-storage')
await app.start()
const drive = await app.publish('./my-app')
// Close your laptop. Your app is still live on 3 continents.
```

Works in **Pear/Bare runtime** natively:

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay/client'

const store = new Corestore(Pear.config.storage)
const app = new HiveRelayClient({ swarm: new Hyperswarm(), store })
await app.start()
```

> See **[Pear Integration Guide](docs/PEAR-INTEGRATION.md)** for full Pear/Bare usage, service RPC, and architecture details.
> See **[examples/pear-app/](examples/pear-app/)** and **[examples/node-app/](examples/node-app/)** for working starter projects.

---

## What Your App Gets

### Always-On Availability
Publish once, relay nodes across multiple continents serve it 24/7. You go to sleep, your users don't notice. If a relay goes down, others still serve your data.

### Every User Can Connect
The ~5% of connections that fail hole-punching (symmetric NATs, corporate firewalls, mobile carriers) get bridged through encrypted circuit relays automatically. Your user doesn't know it happened. Your code doesn't change.

### Dual Transport: P2P + HTTP
Same app, same data, accessible two ways:

| Scenario | P2P (Hyperswarm) | HTTP (Gateway) |
|----------|-------------------|----------------|
| Pear desktop app | Direct P2P | Also browsable via gateway |
| Browser / web app (no UDP) | Not possible | Works via `relay:9100/v1/hyper/{key}/path` |
| Mobile on carrier NAT | Circuit relay bridges it | Works via HTTP |
| curl / scripts / CI | Complex | Simple REST calls |
| Privacy-sensitive (blind mode) | Full P2P with encryption key | Gateway returns 403 |

Any seeded Hyperdrive is browsable at `relay:9100/v1/hyper/{driveKey}/path`. Your Pear app becomes a website with no rebuild.

### App Catalog & Discovery
Relays sync a live catalog of all seeded apps across the network. Publish on one relay, discoverable on all. Developers and users can browse what's available at `/catalog.json`. Blind/encrypted apps appear in the catalog for discovery — name, key, and metadata are visible, but content is only accessible P2P with the encryption key.

### Blind / Encrypted Mode
Relays store and replicate ciphertext they cannot read. Gateway returns 403. Peers discover your app through the catalog, then connect directly with the encryption key. Full availability, zero trust.

```js
const drive = await client.publish('./my-app', {
  encryptionKey: myKey  // 32-byte key — only you and authorized peers can decrypt
})
```

### Services Backend Without a Server
Call AI inference, validate schemas, store data, verify identities — all through `callService()` over your existing P2P connection. No API keys to manage, no servers to deploy.

```js
// P2P service calls — no HTTP needed
const models = await client.callService('ai', 'list-models')
const answer = await client.callService('ai', 'infer', {
  modelId: 'gemma4:latest', input: 'What is 2+2?'
})
const whoami = await client.callService('identity', 'whoami')
```

All 20 service routes are also available via HTTP dispatch:

```bash
curl -X POST http://relay:9100/api/v1/dispatch \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"route": "ai.infer", "params": {"modelId": "gemma4", "prompt": "hello"}}'
```

### Identity With No Passwords
LNURL-auth lets users log in by scanning a QR code with their Lightning wallet. No passwords, no email, no accounts. Developer attestations cryptographically link your Nostr profile to your app keys.

### Free to Use
All services are open right now. 1,000 welcome credits per app, every service route available. Build first, worry about scale later.

---

## Services Layer

20 routes across 6 services, all accessible via P2P `callService()` and HTTP dispatch:

| Service | Routes | Description |
|---------|--------|-------------|
| **AI Inference** | `ai.infer`, `ai.embed`, `ai.list-models`, `ai.status` | Run models on relay hardware (Ollama, OpenAI-compatible) |
| **Storage** | `storage.drive-create`, `drive-list`, `drive-read`, `drive-write` | Hyperdrive and Hypercore CRUD |
| **Identity** | `identity.whoami`, `identity.sign`, `identity.verify`, `identity.developer` | Keypair identity, developer resolution, Nostr profiles |
| **Schema** | `schema.register`, `schema.list`, `schema.validate` | Data format registry for cross-app interop |
| **Compute** | `compute.submit`, `compute.status`, `compute.result` | Task queue with job lifecycle |
| **SLA** | `sla.create`, `sla.get`, `sla.list` | Staked availability guarantees |

---

## Client SDK

```bash
npm install p2p-hiverelay
```

### Content API

| Method | Description |
|--------|-------------|
| `app.publish(dir)` | Publish a directory to a Hyperdrive (reads all files, skips node_modules/.git) |
| `app.publish([{path, content}])` | Publish explicit files |
| `app.open(key)` | Open and replicate a remote drive |
| `app.get(key, path)` | Read a file from a drive |
| `app.put(key, path, content)` | Write a file to a drive |
| `app.list(key, dir)` | List directory contents |
| `app.closeDrive(key)` | Close a drive |

### Relay API

| Method | Description |
|--------|-------------|
| `app.seed(key, opts)` | Request relay nodes to seed your data. Returns acceptances. |
| `app.reserveRelay(relayPubKey)` | Reserve a circuit relay slot for NAT traversal |
| `app.connectViaRelay(target, relay)` | Connect to a peer through a relay |
| `app.callService(svc, method, params)` | Call any service on a relay over P2P |
| `app.getServiceCatalog()` | Get available services from connected relays |
| `app.getAvailableApps()` | Get all apps across all connected relays |
| `app.getRelays()` | List connected relay nodes |
| `app.getSeedStatus(key)` | Check seeding status for an app |

### Events

| Event | Description |
|-------|-------------|
| `ready` / `started` | Client initialized |
| `published` | Content published to a drive |
| `seeded` | Relays accepted seeding |
| `relay-connected` | Connected to a relay node |
| `relay-disconnected` | Relay disconnected |
| `service-catalog` | Service catalog received from relay |
| `app-catalog` | App catalog received from relay |

---

## For Operators

You have hardware — a VPS, a Mac Studio, a Raspberry Pi. HiveRelay turns it into income.

### Install and Start

```bash
npm install -g p2p-hiverelay
p2p-hiverelay start --region NA --max-storage 50GB
```

**That's it.** The node discovers the network, starts accepting work, and begins earning.

### What Your Node Does

- **Seeds apps** — stores and serves Hyperdrives for developers who need always-on availability
- **Relays connections** — bridges NAT-blocked peers through encrypted circuits
- **Syncs catalogs** — automatically discovers and replicates apps from other relays
- **Runs services** — AI inference, compute, storage, identity, schemas, SLAs
- **Proves its work** — cryptographic proof-of-relay challenges verify you're actually serving data
- **Heals itself** — 5 health checks every 30 seconds with automatic recovery
- **Earns reputation** — the more reliably you serve, the more work the network sends you

### Earnings (Rate Card)

| Service | Rate | Hardware Needed |
|---------|------|----------------|
| AI inference | 1 sat/1K input tokens, 2 sats/1K output | 16GB+ RAM, GPU/Apple Silicon |
| Compute tasks | 5 sats/job | 2+ CPU cores |
| Storage write | 2 sats/write | Any ($5 VPS) |
| Storage read | 1 sat/read | Any |
| Identity ops | 1 sat/operation | Any |
| Schema ops | 1 sat/operation | Any |

Revenue splits: 75% held for first 3 months (decreasing to 0% at month 10) to incentivize long-term operation.

### Dashboard

```bash
open http://localhost:9100/dashboard   # Your node's stats
open http://localhost:9100/network     # All relays in the network
open http://localhost:9100/docs        # API documentation
```

Real-time view of connections, storage, bandwidth, reputation, seeded apps, earnings, and health status. WebSocket live feed with HTTP polling fallback.

---

## Identity System

### LNURL-Auth (Passwordless Login)
Developers authenticate by scanning a QR code with their Lightning wallet (LUD-04). No passwords, no email, no accounts — your wallet's secp256k1 key IS your identity.

### Developer Attestations
Cryptographically prove you published an app by signing with your secp256k1 key. Binds your Ed25519 app keys to your developer identity. Your Nostr profile (NIP-01) automatically becomes your developer profile.

### Session Management
24-hour session tokens for authenticated API access after LNURL-auth. Validated via `Authorization: Bearer` header or `X-Session-Token`.

---

## Privacy

Every app declares how much the relay network is allowed to know:

| Tier | What Relays See | What's Protected |
|------|----------------|------------------|
| **Public** (marketplace, blog) | Everything | Nothing — data is indexable |
| **Local-First** (POS, wallet) | App code only | All user data encrypted on device |
| **P2P-Only** (medical, financial) | Nothing at all | Everything — relay never involved with data |

**PolicyGuard enforces it automatically.** If a local-first app's user data attempts to reach a relay, the app is immediately suspended.

**Blind mode** goes further: relay replicates encrypted blocks it cannot decrypt. The app appears in the catalog for discovery, but content requires the encryption key via P2P.

---

## Architecture

```
Developer App
    |
    +-- publish('./my-app')  -->  Hyperdrive (encrypted or plain)
    |                                |
    |                         Hyperswarm DHT
    |                          /     |     \
    |                   Utah    Utah-US   Singapore
    |                   Relay    Relay      Relay
    |                     |        |         |
    |                     +-- Catalog Sync --+
    |
    +-- client.get(key, path)  <--  P2P replication
    |
    +-- HTTP gateway  -->  relay:9100/v1/hyper/{key}/path
```

- **Client SDK** runs in Node.js or Pear/Bare runtime
- **Relay nodes** run on Node.js (VPS/server) — requires `http`, `worker_threads`
- **Bare-compatible imports** via `bare-events`, `bare-fs`, `bare-path`

### Security

- **End-to-end encryption** — relays forward opaque bytes in blind mode
- **Ed25519 signed seed requests** — relays verify ownership
- **Proof-of-relay challenges** — cryptographic verification relays actually hold data
- **Atomic persistence** — tmp-file + rename on all writes
- **Per-peer rate limiting** — token buckets on P2P, per-IP on HTTP
- **Path traversal blocked** — gateway rejects `..`, null bytes, double-encoding
- **Timing-safe API key comparison** — `crypto.timingSafeEqual`
- **All state-modifying endpoints require auth**

---

## Quick Start

> **Requirements**: Node.js 20+

### For Developers

```bash
npm install p2p-hiverelay
```

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'
const app = new HiveRelayClient('./my-storage')
await app.start()
const drive = await app.publish('./my-app')
console.log('Key:', drive.key.toString('hex'))
```

### For Operators

```bash
npm install -g p2p-hiverelay
p2p-hiverelay start --region NA --max-storage 50GB --port 9100
```

### Seeding Pear Apps

```bash
# Stage and get key
cd /path/to/pear-app && pear stage dev . && pear info dev .

# Seed to relay
curl -X POST http://localhost:9100/seed \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"appKey": "HEX_KEY", "appId": "my-app", "version": "1.0.0"}'
```

### Local Testnet

```bash
npx p2p-hiverelay testnet          # 3 relays + test client
npx p2p-hiverelay testnet --nodes 5  # 5 relays
```

---

## What's Not Done Yet

| Area | Status | Gap |
|------|--------|-----|
| AI embeddings | Inference works (Ollama/gemma4) | Embedding models not tested |
| Lightning payments | Invoice creation works | No LND backend connected for settlement |
| Compute sandbox | Handler registered | No container/WASM isolation for untrusted code |
| ZK proofs | Service designed | Not implemented |
| Mobile | Architecture supports it | No mobile testing |

---

## Test Coverage

179 integration tests against the live 3-server network, all passing:

| Suite | Tests | Coverage |
|-------|-------|----------|
| Router | 37 | Dispatch, cross-relay, latency, errors, concurrent load |
| Circuit Relay | 19 | Stats, bandwidth, capacity, Prometheus, health |
| Gateway | 19 | File serving, security, content types, cross-relay |
| Credits | 22 | Pricing, wallets, metering, quotas, invoices |
| Identity | 18 | LNURL-auth, attestations, sessions, cross-relay sync |
| Health | 26 | Memory, connections, disk, self-heal, uptime |
| Blind Mode | 12 | Encrypted publish, gateway rejection, P2P access |
| P2P Services | 15 | callService, catalog exchange, concurrent calls |
| Pear Runtime | 11 | Bare import, publish, discovery, callService, cleanup |

---

## Links

- **GitHub**: [github.com/bigdestiny2/P2P-Hiveswarm](https://github.com/bigdestiny2/P2P-Hiveswarm)
- **npm**: `npm install p2p-hiverelay`
- **Pear Guide**: [docs/PEAR-INTEGRATION.md](docs/PEAR-INTEGRATION.md)
- **Examples**: [examples/pear-app/](examples/pear-app/) | [examples/node-app/](examples/node-app/)
- **Dashboard**: `http://{relay}:9100/dashboard`
- **Catalog**: `http://{relay}:9100/catalog.json`
- **Health**: `http://{relay}:9100/health`
- **Metrics**: `http://{relay}:9100/metrics`
- **Docs**: `http://{relay}:9100/docs`

---

No blockchain. No token. Just infrastructure that keeps your apps online.
