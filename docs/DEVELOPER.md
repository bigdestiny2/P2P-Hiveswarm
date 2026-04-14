# HiveRelay Developer Documentation

**Version:** 0.3.0
**License:** Apache 2.0
**Runtime:** Node.js >= 20.0.0
**Module System:** ESM (`"type": "module"`)

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Architecture Overview](#2-architecture-overview)
3. [Project Structure](#3-project-structure)
4. [Client SDK Reference](#4-client-sdk-reference)
5. [Relay Node Reference](#5-relay-node-reference)
6. [Wire Protocol](#6-wire-protocol)
7. [Core Protocols](#7-core-protocols)
8. [Incentive Layer](#8-incentive-layer)
9. [Transport Plugins](#9-transport-plugins)
10. [HTTP API Reference](#10-http-api-reference)
11. [Prometheus Metrics](#11-prometheus-metrics)
12. [CLI Reference](#12-cli-reference)
13. [Configuration](#13-configuration)
14. [Agent Integration](#14-agent-integration)
15. [Testing](#15-testing)
16. [Security Model](#16-security-model)
17. [Deployment Guide](#17-deployment-guide)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Quick Start

### For Pear App Developers (Client SDK)

Install HiveRelay as a dependency:

```bash
npm install p2p-hiverelay
```

Publish a Pear app that stays alive when you go offline:

```js
import { HiveRelayClient } from 'p2p-hiverelay/client'

const app = new HiveRelayClient('./my-app-storage')
await app.start()

// Publish content — relay nodes pick it up automatically
const drive = await app.publish([
  { path: '/index.html', content: '<h1>My Pear App</h1>' },
  { path: '/app.js', content: 'console.log("running")' }
])

console.log('Share this key:', drive.key.toString('hex'))
```

Open published content on another device:

```js
const app = new HiveRelayClient('./user-storage')
await app.start()

const drive = await app.open(key)
const html = await app.get(key, '/index.html')
// Content available even if the publisher is offline
```

### For Relay Node Operators

```bash
# First-time setup
npx p2p-hiverelay init --region NA --max-storage 50GB

# Start the relay node
hiverelay start --port 9100

# Verify it's running
curl http://localhost:9100/health
```

### From Source

```bash
git clone https://github.com/hiverelay/hiverelay.git
cd hiverelay
npm install
npm start
```

---

## 2. Architecture Overview

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│  PEAR APPS (Keet, POS, custom apps)                         │
│  └── HiveRelayClient SDK                                    │
├─────────────────────────────────────────────────────────────┤
│  HIVERELAY PROTOCOL                                         │
│  ├── Seed Registry (Autobase multi-writer)                  │
│  ├── Circuit Relay (NAT traversal, E2E encrypted)           │
│  ├── Proof-of-Relay (cryptographic challenge-response)      │
│  └── Bandwidth Receipts (Ed25519 signed proofs)             │
├─────────────────────────────────────────────────────────────┤
│  INCENTIVE LAYER                                            │
│  ├── Reputation System (score, decay, leaderboard)          │
│  ├── Payment Manager (held-amount schedule)                 │
│  └── Lightning Provider (LND gRPC)                          │
├─────────────────────────────────────────────────────────────┤
│  HYPERSWARM / HYPERDHT                                      │
│  Kademlia DHT + Noise_XX encryption                         │
├─────────────────────────────────────────────────────────────┤
│  TRANSPORTS                                                 │
│  UDP (default) │ WebSocket │ Tor        │ Holesail          │
└─────────────────────────────────────────────────────────────┘
```

### How Discovery Works

All HiveRelay nodes (relays and clients) use a well-known DHT topic for discovery. The topic is derived from the string `hiverelay-discovery-v1` by hashing with `crypto_generichash` (BLAKE2b) into a 32-byte buffer:

```js
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))
```

Relay nodes join this topic as **servers** (`{ server: true, client: false }`). Clients join as **clients** (`{ server: false, client: true }`). When a client joins the topic, Hyperswarm's DHT lookup finds relay nodes automatically — no hardcoded addresses, no DNS, no central server.

### Data Flow

```
Developer publishes content
    │
    ▼
HiveRelayClient creates Hyperdrive, writes files
    │
    ▼
Client signs seed request (Ed25519) and broadcasts to relay nodes
    │
    ▼
Relay nodes verify signature, check capacity, send SEED_ACCEPT
    │
    ▼
Relay nodes download all blocks via Corestore replication
    │
    ▼
Relay nodes re-announce on DHT every 15 minutes
    │
    ▼
Developer goes offline — relay nodes continue serving
    │
    ▼
End user opens app by key — discovers relays via DHT — gets content
```

---

## 3. Project Structure

```
hiverelay/
├── package.json                  # Project manifest, deps, scripts
├── core/
│   ├── index.js                  # Main module exports (12 exports)
│   ├── protocol/
│   │   ├── messages.js           # Wire protocol: message types, error codes, encodings
│   │   ├── seed-request.js       # Seed request/accept protocol over Protomux
│   │   ├── relay-circuit.js      # Circuit relay protocol for NAT traversal
│   │   ├── proof-of-relay.js     # Cryptographic challenge-response verification
│   │   ├── bandwidth-receipt.js  # Ed25519-signed bandwidth proofs + replay detection
│   │   └── rate-limiter.js       # Token bucket rate limiter for P2P messages
│   ├── app-registry.js            # Unified AppRegistry — single source of truth for all apps
│   ├── relay-node/
│   │   ├── index.js              # RelayNode class — lifecycle, start/stop/rollback
│   │   ├── api.js                # RelayAPI — HTTP API + management endpoints (:9100)
│   │   ├── metrics.js            # Metrics — Prometheus export, circular buffer
│   │   ├── relay.js              # Relay — circuit forwarding with backpressure
│   │   └── seeder.js             # Seeder — Hypercore download + re-announce
│   └── registry/
│       └── index.js              # SeedingRegistry — Autobase multi-writer
├── client/
│   └── index.js                  # HiveRelayClient SDK
├── cli/
│   ├── index.js                  # CLI tool: setup, manage, init, start, seed, status
│   ├── setup.js                  # Interactive setup wizard (TUI)
│   └── manage.js                 # Live management console (TUI)
├── config/
│   ├── default.js                # Default configuration values
│   └── loader.js                 # Config precedence: CLI > file > defaults
├── incentive/
│   ├── payment/
│   │   ├── index.js              # PaymentManager — held-amount schedule, settlement
│   │   ├── lightning-provider.js # LightningProvider — LND gRPC integration
│   │   └── mock-provider.js      # MockProvider — in-memory testing provider
│   └── reputation/
│       └── index.js              # ReputationSystem — scoring, decay, selection
├── transports/
│   ├── websocket/
│   │   ├── index.js              # WebSocketTransport — ws server for browser peers
│   │   └── stream.js             # WebSocketStream — Duplex adapter for Protomux
│   ├── tor/
│   │   └── index.js              # TorTransport (hidden service + SOCKS5 proxy)
│   └── holesail/
│       └── index.js              # HolesailTransport (TCP/UDP tunneling over Hyperswarm)
├── platform/                         # Privacy platform APIs
│   ├── index.js                      # Exports all platform primitives
│   ├── crypto.js                     # XChaCha20-Poly1305 encrypt/decrypt, BLAKE2b hash
│   ├── keys.js                       # KeyManager — device key gen, HKDF derivation hierarchy
│   ├── storage.js                    # LocalStorage — encrypted key-value store on device
│   └── privacy.js                    # PrivacyManager — tier enforcement, audit, sync control
├── standalone/                       # Standalone P2P block storage (Tier 3 reference impl)
│   ├── server.js                     # Hyperswarm + Hypercore + protomux-rpc server
│   ├── client.js                     # Interactive client with REPL
│   ├── demo.js                       # Self-contained demo (local testnet)
│   ├── test.js                       # 10 tests (all passing)
│   └── ARCHITECTURE.md               # Full technical + non-technical explainer
├── compute/
│   └── gateway/
│       └── hyper-gateway.js      # HTTP gateway for Hyperdrive content (LRU cache, path security)
├── plugins/
│   └── openclaw/
│       ├── index.ts              # OpenClaw TypeScript plugin (162 lines)
│       └── package.json          # Plugin manifest
├── skills/
│   └── SKILL.md                  # Agent skill definition (Hermes/OpenClaw)
├── scripts/
│   ├── setup-dev.sh              # Dev environment setup
│   ├── transfer.sh               # Deployment archive script
│   ├── publish-app.js            # Publish apps to relay (blind mode, encryption keys)
│   ├── local-network.js          # Local 3-node bootstrap for testing
│   └── mvn-test.js               # Minimum Viable Network integration test
├── test/
│   ├── unit/                     # 10 unit test files + privacy-tiers.test.js
│   └── integration/              # 2 integration test files
└── docs/
    ├── PROTOCOL-SPEC.md          # Wire protocol specification (721 lines)
    └── ECONOMICS.md              # Token economics & incentive design (1198 lines)
```

### Module Exports

The main entry point (`core/index.js`) exports:

```js
export { RelayNode } from './relay-node/index.js'
export { SeedingRegistry } from './registry/index.js'
export { SeedProtocol } from './protocol/seed-request.js'
export { CircuitRelay } from './protocol/relay-circuit.js'
export { ProofOfRelay } from './protocol/proof-of-relay.js'
export { BandwidthReceipt } from './protocol/bandwidth-receipt.js'
export { RelayAPI } from './relay-node/api.js'
export { WebSocketTransport } from '../transports/websocket/index.js'
export { WebSocketStream } from '../transports/websocket/stream.js'
export { LightningProvider } from '../incentive/payment/lightning-provider.js'
export { MockProvider } from '../incentive/payment/mock-provider.js'
export { HiveRelayClient } from '../client/index.js'
```

Import from the package:

```js
// Core module (relay operators)
import { RelayNode, ProofOfRelay, BandwidthReceipt } from 'p2p-hiverelay'

// Client SDK (app developers)
import { HiveRelayClient } from 'p2p-hiverelay/client'
```

### Dependencies

| Package | Purpose |
|---------|---------|
| `hyperswarm` | P2P networking, connection management |
| `hyperdht` | Kademlia DHT with Noise_XX encryption |
| `hypercore` | Append-only log with Merkle trees |
| `hyperdrive` | File system over Hypercore |
| `corestore` | Multi-core storage management |
| `autobase` | Multi-writer database for seed registry |
| `protomux` | Protocol multiplexer over streams |
| `compact-encoding` | Binary message encoding |
| `sodium-universal` | Ed25519 signatures, BLAKE2b hashing |
| `b4a` | Buffer/Uint8Array compatibility |
| `ws` | WebSocket server for browser peers |
| `@grpc/grpc-js` | Lightning Network LND communication |
| `minimist` | CLI argument parsing |
| `graceful-goodbye` | Clean shutdown handling |

---

## 4. Client SDK Reference

**File:** `client/index.js` (670 lines)
**Import:** `import { HiveRelayClient } from 'p2p-hiverelay/client'`

### Constructor

```js
// Simple mode — auto-creates Corestore + Hyperswarm
const app = new HiveRelayClient('./my-storage')

// Simple mode with options
const app = new HiveRelayClient('./my-storage', {
  autoDiscover: true,       // Find relay nodes automatically (default: true)
  maxRelays: 10,            // Max relay connections to maintain (default: 10)
  autoSeed: true,           // Auto-request seeding on publish (default: true)
  seedReplicas: 3,          // Number of relay replicas (default: 3)
  seedTimeout: 10_000,      // Seed request timeout in ms (default: 10000)
  connectionTimeout: 10_000, // General connection timeout (default: 10000)
  bootstrap: null           // Custom DHT bootstrap nodes (default: HyperDHT defaults)
})

// Advanced mode — bring your own Hyperswarm + Corestore
const app = new HiveRelayClient({
  swarm: mySwarm,
  store: myStore,
  keyPair: myKeyPair        // Optional — defaults to swarm.keyPair
})
```

**Ownership rules:** When you provide `swarm` or `store`, the client will NOT destroy them on `app.destroy()`. When the client creates them (simple mode), it owns and destroys them.

### Content API

#### `app.start()` → `Promise<HiveRelayClient>`

Initialize the client and begin relay discovery. Must be called before any other method.

```js
const app = new HiveRelayClient('./storage')
await app.start()
// Client is ready — emits 'ready' and 'started' events
```

**What it does internally:**
1. Creates Corestore (if not provided) and calls `store.ready()`
2. Creates Hyperswarm (if not provided)
3. Sets up connection handler: `store.replicate(conn)` + protocol channels
4. Joins the `hiverelay-discovery-v1` DHT topic as a client
5. Calls `swarm.flush()` to wait for initial connections

#### `app.publish(files, opts?)` → `Promise<Hyperdrive>`

Create a new Hyperdrive, write files, and optionally request relay seeding.

```js
const drive = await app.publish([
  { path: '/index.html', content: '<h1>Hello</h1>' },
  { path: '/app.js', content: 'console.log("ok")' },
  { path: '/data.json', content: Buffer.from(JSON.stringify({ v: 1 })) }
], {
  seed: true,       // Request relay seeding (default: this.autoSeed)
  replicas: 3,      // Number of relays to seed on (default: this.seedReplicas)
  timeout: 15_000   // How long to wait for seed acceptances (default: this.seedTimeout)
})

console.log(drive.key.toString('hex')) // 64-char hex key to share
```

**Behavior:**
- Content can be `string` or `Buffer` — strings are auto-converted with `b4a.from()`
- Joins the drive's discovery key on Hyperswarm for replication
- If `seed` is true, calls `this.seed()` and emits `'seeded'` or `'seed-error'`
- Emits `'published'` with `{ key, files: count }`

#### `app.open(key, opts?)` → `Promise<Hyperdrive>`

Open an existing Hyperdrive by key and replicate from the network.

```js
const drive = await app.open('a1b2c3d4e5f6...') // 64-char hex
// or
const drive = await app.open(keyBuffer) // 32-byte Buffer

const html = await app.get(drive.key.toString('hex'), '/index.html')
```

**Options:**
- `wait` (boolean, default: `true`) — Wait for initial drive update from network
- `timeout` (number, default: `15000`) — How long to wait for first update in ms

**Behavior:**
- Returns cached drive if already opened with the same key
- Joins the drive's discovery key for replication
- On timeout, emits `'open-timeout'` but still returns the drive (it may update later)

#### `app.get(driveKey, path)` → `Promise<Buffer|null>`

Read a file from an opened drive.

```js
const content = await app.get(keyHex, '/index.html')
console.log(content.toString()) // '<h1>Hello</h1>'
```

#### `app.put(driveKey, path, content)` → `Promise<void>`

Write a file to an owned drive.

```js
await app.put(keyHex, '/data.json', JSON.stringify({ updated: true }))
```

#### `app.list(driveKey, dir?)` → `Promise<string[]>`

List files in a drive directory.

```js
const files = await app.list(keyHex, '/')
// ['/index.html', '/app.js', '/data.json']
```

#### `app.closeDrive(driveKey)` → `Promise<void>`

Close a specific drive and leave its swarm topic.

```js
await app.closeDrive(keyHex)
```

### Relay API

#### `app.seed(appKey, opts?)` → `Promise<object[]>`

Request relay seeding for a Hypercore/Hyperdrive key. Broadcasts a signed seed request to all connected relays and waits for acceptances.

```js
const acceptances = await app.seed(driveKey, {
  replicas: 5,          // Target number of relay replicas
  region: 'EU',         // Geographic preference
  maxStorage: 500 * 1024 * 1024,  // 500 MB max per relay
  ttlDays: 30,          // Seed request TTL
  timeout: 15_000       // How long to wait for acceptances
})

console.log(`${acceptances.length} relays accepted`)
```

**How it works:**
1. Computes discovery key from the app key via `crypto_generichash`
2. Joins the discovery key on Hyperswarm
3. Builds a seed request message with `publisherPubkey` and `publisherSignature`
4. Signs the request with Ed25519 (`crypto_sign_detached`) using `this.keyPair.secretKey`
5. Sends the request to all connected relays via the `hiverelay-seed` Protomux channel
6. Waits up to `timeout` ms for `replicas` acceptances
7. Returns array of acceptance objects

**Seed request fields signed:**

```
appKey (32 bytes) + discoveryKeys (32 bytes each) + metadata (24 bytes)
  metadata: replicationFactor (1 byte) + maxStorageBytes (8 bytes) + ttlSeconds (8 bytes)
```

#### `app.unseed(appKey)` → `Promise<{ relays: number }>`

Remotely unseed your app from all connected relays (developer kill switch). Signs the request with your keypair to prove publisher ownership.

```js
const result = await app.unseed(driveKey)
console.log(`Unseed broadcast to ${result.relays} relays`)
```

**Signature format:** `Ed25519(appKey + 'unseed' + uint64_be(timestamp))`

Relays verify the signature against the `publisherPubkey` stored when the app was originally seeded. The unseed propagates across the network via P2P broadcast.

#### `app.reserveRelay(relayPubKey)` → `Promise<boolean>`

Reserve a circuit relay slot for NAT traversal.

```js
const reserved = await app.reserveRelay(relayPubkeyHex)
if (reserved) {
  console.log('Relay slot reserved')
}
```

#### `app.connectViaRelay(targetPubKey, relayPubKey?)` → `Promise<boolean>`

Connect to a peer through a relay node. If no relay is specified, selects the first available.

```js
const connected = await app.connectViaRelay(targetPubkeyHex)
```

### Status Methods

#### `app.getRelays()` → `object[]`

```js
const relays = app.getRelays()
// [{ pubkey, hasSeedProtocol, hasCircuitProtocol, connectedAt }]
```

#### `app.getSeedStatus(appKey)` → `object|null`

```js
const status = app.getSeedStatus(keyHex)
// { appKey, acceptances: 3, relays: [{ pubkey, region }] }
```

#### `app.getStatus()` → `object`

```js
const status = app.getStatus()
// { started: true, relays: [...], drives: 2, connections: 47 }
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `ready` | — | Client initialized |
| `started` | — | Client started |
| `published` | `{ key, files }` | Drive published |
| `opened` | `{ key }` | Remote drive opened |
| `open-timeout` | `{ key, error }` | Drive update timed out |
| `seeded` | `{ key, acceptances }` | Seed request accepted |
| `seed-error` | `{ key, error }` | Seed request failed |
| `seed-request-published` | `{ appKey }` | Seed request broadcast sent |
| `seed-accepted` | `{ appKey, relay, region }` | A relay accepted seeding |
| `relay-connected` | `{ pubkey }` | Connected to a relay node |
| `relay-disconnected` | `{ pubkey }` | Disconnected from a relay |
| `relay-reserved` | `{ relay }` | Circuit relay slot reserved |
| `relay-status` | `{ relay, code, message }` | Circuit status update |
| `destroyed` | — | Client shut down |

### Cleanup

```js
await app.destroy()
```

Closes all drives, leaves all swarm topics, clears all state. If the client created its own Corestore and Hyperswarm (simple mode), those are destroyed too. If you provided them (advanced mode), they're left untouched.

---

## 5. Relay Node Reference

**File:** `core/relay-node/index.js` (263 lines)
**Import:** `import { RelayNode } from 'p2p-hiverelay'`

### Constructor

```js
const node = new RelayNode({
  storage: './storage',              // Corestore path
  maxStorageBytes: 50 * 1024**3,     // 50 GB max
  maxConnections: 256,               // Max peer connections
  maxRelayBandwidthMbps: 100,        // Max relay bandwidth
  announceInterval: 15 * 60 * 1000,  // DHT re-announce interval
  regions: ['NA'],                   // Region codes
  enableRelay: true,                 // Enable circuit relay
  enableSeeding: true,               // Enable app seeding
  enableMetrics: true,               // Enable Prometheus metrics
  enableAPI: true,                   // Enable HTTP API
  apiPort: 9100,                     // API port
  bootstrapNodes: null,              // null = HyperDHT defaults
  shutdownTimeoutMs: 10_000,         // Per-step shutdown timeout
  transports: {
    websocket: false                 // Enable WebSocket transport
  },
  wsPort: 8765                       // WebSocket port
})
```

### Lifecycle

#### `node.start()` → `Promise<RelayNode>`

Start the relay node. Components initialize in order:

1. `Corestore.ready()` — Storage initialization
2. `new Hyperswarm()` — Join DHT network
3. Join `hiverelay-discovery-v1` topic as **server**
4. `Seeder.start()` — If `enableSeeding` is true
5. `Relay.start()` — If `enableRelay` is true
6. `new Metrics()` — If `enableMetrics` is true
7. `RelayAPI.start()` — If `enableAPI` is true
8. `WebSocketTransport.start()` — If `transports.websocket` is true
9. Payment settlement interval — If `payment.enabled` is true

**Rollback on failure:** If any component fails during startup, all previously initialized components are torn down in reverse order. The node is always either fully running or fully stopped — never in a partial state.

```js
try {
  await node.start()
  console.log('Public key:', node.swarm.keyPair.publicKey.toString('hex'))
} catch (err) {
  // Node is already rolled back — safe to retry or exit
  console.error('Startup failed:', err)
}
```

#### `node.stop()` → `Promise<void>`

Graceful shutdown with per-step timeouts (default: 10 seconds each):

1. Clear settlement interval
2. Stop WebSocket transport
3. Stop HTTP API
4. Stop Metrics
5. Unseed all apps (leave swarm topics, close drives)
6. Stop Relay (close all circuits)
7. Stop Seeder (close all cores)
8. Destroy Hyperswarm
9. Close Corestore

Each step has a `withTimeout()` wrapper — if a step hangs, it's skipped after the timeout so shutdown never blocks indefinitely.

```js
await node.stop()
// All intervals cleared, all connections closed
```

### Seeding Apps

#### `node.seedApp(appKeyHex, opts?)` → `Promise<{ discoveryKey: string }>`

Seed a Pear app by key. Creates a Hyperdrive, joins its discovery key on the swarm, and begins replicating.

```js
// Standard seeding — full replication
const result = await node.seedApp('a1b2c3d4e5f6...')
console.log('Discovery key:', result.discoveryKey)

// With metadata
const result = await node.seedApp('a1b2c3d4e5f6...', {
  appId: 'my-cool-app',
  version: '1.0.0'
})

// Blind mode — discovery only, no content replication
const result = await node.seedApp('a1b2c3d4e5f6...', {
  blind: true,
  appId: 'my-private-app',
  version: '2.0.0'
})
// result.discoveryKey is null for blind apps
```

**Validation:** The key must be exactly 64 hex characters, normalized to lowercase. Invalid keys throw immediately.

**Blind mode behavior:**
- Registers the app in the relay's catalog and registry (appId → driveKey mapping)
- Does NOT open any Hypercore, join DHT, or download blocks
- App appears in `/catalog.json` with `blind: true`
- Hyper Gateway returns `403 Private app` for blind apps
- Useful for encrypted apps where the relay cannot read the content
- Max 500 blind registrations per relay (configurable via `maxBlindRegistrations`)

#### `node.unseedApp(appKeyHex)` → `Promise<void>`

Stop seeding an app. For standard apps: leaves the swarm topic and closes the drive. For blind apps: removes the registry entry.

```js
await node.unseedApp('a1b2c3d4e5f6...')
```

### Stats

#### `node.getStats()` → `object`

```js
const stats = node.getStats()
// {
//   running: true,
//   publicKey: '...',
//   seededApps: 3,
//   connections: 47,
//   relay: { activeCircuits, totalCircuitsServed, totalBytesRelayed, capacityUsedPct },
//   seeder: { coresSeeded, totalBytesStored, totalBytesServed, capacityUsedPct }
// }
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `started` | `{ publicKey }` | Node started successfully |
| `stopped` | — | Node fully stopped |
| `connection` | `{ info, remotePubKey }` | New peer connected |
| `connection-error` | `{ error, info }` | Connection error |
| `connection-closed` | `{ info }` | Peer disconnected |
| `seeding` | `{ appKey, discoveryKey }` | Started seeding an app |
| `unseeded` | `{ appKey }` | Stopped seeding an app |
| `settlement-error` | `{ relay?, error }` | Payment settlement failed |

---

## 6. Wire Protocol

**File:** `core/protocol/messages.js` (247 lines)
**Spec:** `docs/PROTOCOL-SPEC.md` (721 lines)

All messages use `compact-encoding` and are framed over `protomux` channels on Hyperswarm connections.

### Message Types

```js
import { MSG, ERR, REGIONS } from 'p2p-hiverelay'
```

#### Seeding Messages (0x01–0x06)

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| `0x01` | `SEED_REQUEST` | Client → Relay | Request seeding of a Hypercore/Hyperdrive |
| `0x02` | `SEED_ACCEPT` | Relay → Client | Relay accepts with capacity info |
| `0x03` | `SEED_REJECT` | Relay → Client | Relay rejects (capacity, invalid sig) |
| `0x04` | `SEED_CANCEL` | Client → Relay | Cancel a seed request |
| `0x05` | `SEED_HEARTBEAT` | Bidirectional | Keepalive for seeding relationship |
| `0x06` | `SEED_STATUS` | Relay → Client | Status update (bytes stored/served) |

#### Circuit Relay Messages (0x10–0x18)

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| `0x10` | `RELAY_RESERVE` | Peer → Relay | Reserve a relay slot |
| `0x11` | `RELAY_RESERVE_OK` | Relay → Peer | Reservation confirmed |
| `0x12` | `RELAY_RESERVE_DENY` | Relay → Peer | Reservation denied |
| `0x13` | `RELAY_CONNECT` | Peer → Relay | Request circuit to target |
| `0x14` | `RELAY_CONNECT_OK` | Relay → Peer | Circuit established |
| `0x15` | `RELAY_CONNECT_DENY` | Relay → Peer | Circuit denied |
| `0x16` | `RELAY_DATA` | Bidirectional | Opaque E2E-encrypted bytes |
| `0x17` | `RELAY_CLOSE` | Either → Other | Close circuit |
| `0x18` | `RELAY_UPGRADE` | Bidirectional | Upgrade to direct connection |

#### Proof-of-Relay Messages (0x20–0x23)

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| `0x20` | `PROOF_CHALLENGE` | Verifier → Relay | Challenge: prove you have block N |
| `0x21` | `PROOF_RESPONSE` | Relay → Verifier | Response: block data + Merkle proof |
| `0x22` | `BANDWIDTH_RECEIPT` | Peer → Relay | Signed acknowledgment of data served |
| `0x23` | `RECEIPT_ACK` | Relay → Peer | Receipt received and verified |

#### Peer Discovery Messages (0x30–0x32)

| Code | Name | Direction | Description |
|------|------|-----------|-------------|
| `0x30` | `PEER_ANNOUNCE` | Relay → DHT | Announce relay capabilities |
| `0x31` | `PEER_QUERY` | Client → DHT | Query for relay nodes |
| `0x32` | `PEER_RESPONSE` | DHT → Client | Relay node list |

### Error Codes

```js
const ERR = {
  NONE: 0x00,             // Success
  CAPACITY_FULL: 0x01,    // Relay at capacity
  INVALID_REQUEST: 0x02,  // Malformed message
  NOT_FOUND: 0x03,        // Core/block not found
  TIMEOUT: 0x04,          // Operation timed out
  STORAGE_EXCEEDED: 0x05, // Storage limit hit
  BANDWIDTH_EXCEEDED: 0x06, // Bandwidth limit hit
  DURATION_EXCEEDED: 0x07,  // Circuit duration exceeded
  PROOF_FAILED: 0x08,     // Proof verification failed
  UNAUTHORIZED: 0x09,     // Invalid signature
  PROTOCOL_ERROR: 0x0A,   // Protocol version mismatch
  INTERNAL_ERROR: 0xFF    // Internal error
}
```

### Message Encodings

All encodings use `compact-encoding` with fixed-size buffers for keys and signatures:

**Seed Request:**

```
appKey:              fixed32 (32 bytes — Hypercore public key)
discoveryKeys:       uint (count) + fixed32[] (32 bytes each)
replicationFactor:   uint
geoPreference:       string (JSON array of region codes)
maxStorageBytes:     uint
bountyRate:          uint
ttlSeconds:          uint
publisherPubkey:     fixed32 (32 bytes — Ed25519 public key)
publisherSignature:  fixed64 (64 bytes — Ed25519 signature)
```

**Seed Accept:**

```
appKey:              fixed32
relayPubkey:         fixed32
region:              string
availableStorageBytes: uint
relaySignature:      fixed64
```

**Proof Challenge:**

```
coreKey:     fixed32
blockIndex:  uint
nonce:       fixed32 (32 bytes — random, replay prevention)
maxLatencyMs: uint
```

**Proof Response:**

```
coreKey:     fixed32
blockIndex:  uint
blockData:   buffer (variable length)
merkleProof: buffer (variable length)
nonce:       fixed32 (echoed from challenge)
```

**Bandwidth Receipt:**

```
relayPubkey:     fixed32
peerPubkey:      fixed32
bytesTransferred: uint
timestamp:       uint
sessionId:       fixed32
peerSignature:   fixed64
```

**Relay Reserve:**

```
peerPubkey:   fixed32
maxDurationMs: uint
maxBytes:      uint
```

### Protomux Channels

The protocol uses two named Protomux channels:

| Channel Name | Purpose | Messages |
|---|---|---|
| `hiverelay-seed` | Seeding protocol | SEED_REQUEST, SEED_ACCEPT |
| `hiverelay-circuit` | Circuit relay | RELAY_RESERVE, RELAY_CONNECT, status |
| `hiverelay-proof` | Proof-of-relay | PROOF_CHALLENGE, PROOF_RESPONSE |

---

## 7. Core Protocols

### 7.1 Seed Protocol

**File:** `core/protocol/seed-request.js`

The seed protocol manages the negotiation between publishers and relay nodes for content seeding.

```js
import { SeedProtocol } from 'p2p-hiverelay'

const seed = new SeedProtocol(corestore, { maxStorageBytes: 50 * 1024**3 })
seed.attach(conn) // Attach to a Hyperswarm connection
```

**Flow:**
1. Client sends `SEED_REQUEST` with signed app key and preferences
2. Relay verifies signature, checks capacity
3. Relay sends `SEED_ACCEPT` or `SEED_REJECT`
4. On accept, relay begins downloading blocks via Corestore replication

### 7.2 Circuit Relay

**File:** `core/relay-node/relay.js` (131 lines)

The circuit relay forwards opaque encrypted bytes between peers that can't connect directly.

```js
import { Relay } from 'p2p-hiverelay'

const relay = new Relay(swarm, {
  maxBandwidthMbps: 100,
  maxConnections: 256,
  maxCircuitDuration: 10 * 60 * 1000,  // 10 minutes
  maxCircuitBytes: 64 * 1024 * 1024     // 64 MB
})

await relay.start()

// Create a circuit between two peers
const circuit = relay.createCircuit('circuit-123', sourceStream, destStream)
```

**Limits enforced per circuit:**
- **64 MB** maximum bytes relayed
- **10 minutes** maximum duration
- **5 circuits** per peer
- **256** total circuits

**Backpressure:** The relay monitors `stream.write()` return values. When a destination buffer fills (`write()` returns false), the source stream is paused. It resumes on the destination's `'drain'` event. This prevents memory exhaustion under load.

**Circuit lifecycle:**
1. `createCircuit()` — Sets up bidirectional forwarding
2. Bytes flow: `source.on('data')` → `dest.write()` (and reverse)
3. Close triggers: byte limit, time limit, peer disconnect, shutdown
4. `_closeCircuit()` — Clears timer, destroys both streams, emits event

### 7.3 Proof-of-Relay

**File:** `core/protocol/proof-of-relay.js` (219 lines)

Cryptographic verification that relay nodes actually hold data.

```js
import { ProofOfRelay } from 'p2p-hiverelay'

const proof = new ProofOfRelay({
  maxLatencyMs: 5000,             // 5-second response deadline
  challengeInterval: 5 * 60 * 1000 // Challenge every 5 minutes
})

// Attach to a connection
const channel = proof.attach(conn)

// Issue a challenge
proof.challenge(channel, coreKey, blockIndex, relayPubkey)

// Listen for results
proof.on('proof-result', ({ relayPubkey, passed, latencyMs }) => {
  console.log(passed ? 'PASS' : 'FAIL', latencyMs + 'ms')
})
```

**Challenge flow:**
1. Verifier generates 32-byte random nonce (`sodium.randombytes_buf`)
2. Sends `PROOF_CHALLENGE` with `{ coreKey, blockIndex, nonce, maxLatencyMs }`
3. Relay fetches block from local Hypercore via `blockProvider` callback
4. Relay sends `PROOF_RESPONSE` with `{ blockData, merkleProof, nonce }`
5. Verifier checks: nonce match, correct core/block, non-empty data, within latency bound
6. Updates relay score: **+10 pass, -20 fail** (asymmetric penalty)

**Anti-replay:** Each challenge includes a unique random nonce. Stale challenges are auto-cleaned every 30 seconds (removing pending entries older than 2× max latency).

**On the relay side:**

```js
proof.setBlockProvider(async (coreKeyHex, blockIndex) => {
  const core = store.get({ key: Buffer.from(coreKeyHex, 'hex') })
  await core.ready()
  const data = await core.get(blockIndex)
  return { data, proof: Buffer.alloc(0) }
})
```

**Scoring methods:**

```js
proof.getScore(relayPubkeyHex)
// { challenges, passes, fails, totalLatencyMs, avgLatencyMs }

proof.getReliability(relayPubkeyHex)
// 0.0 – 1.0 (passes / total challenges)

proof.getAllScores()
// { [pubkey]: { ...score, reliability } }
```

### 7.4 Bandwidth Receipts

**File:** `core/protocol/bandwidth-receipt.js` (141 lines)

Non-repudiable proof of data transfer, signed with Ed25519.

```js
import { BandwidthReceipt } from 'p2p-hiverelay'

// Receiving peer creates and signs receipts
const receipt = new BandwidthReceipt(keyPair, { maxReceipts: 10_000 })

const signed = receipt.createReceipt(relayPubkey, bytesTransferred, sessionId)
// signed.peerSignature is a 64-byte Ed25519 detached signature
```

**Receipt payload (signed):**

```
relayPubkey (32 bytes) + peerPubkey (32 bytes) + bytesTransferred (8 bytes)
+ timestamp (4 bytes) + sessionId (32 bytes)
= 108 bytes signed with crypto_sign_detached
```

**Verification (anyone can verify):**

```js
const valid = BandwidthReceipt.verify(receipt) // true/false
```

**Relay-side collection:**

```js
const relayReceipts = new BandwidthReceipt(relayKeyPair)
const accepted = relayReceipts.collectReceipt(receipt)
// Returns false if signature is invalid

const totalBandwidth = relayReceipts.getTotalProvenBandwidth()
const windowReceipts = relayReceipts.getReceiptsInWindow(start, end)
const exported = relayReceipts.exportReceipts() // hex-string format for persistence
```

**Bounded memory:** Receipts are capped at 10,000 per instance. When the cap is reached, the oldest receipts are evicted (FIFO).

### 7.5 Seeder

**File:** `core/relay-node/seeder.js` (107 lines)

Downloads and re-serves Hypercores for persistent content availability.

```js
const seeder = new Seeder(store, swarm, {
  maxStorageBytes: 50 * 1024 * 1024 * 1024,
  announceInterval: 15 * 60 * 1000
})

await seeder.start()
await seeder.seedCore(publicKeyHex)
```

**Per-core tracking:**
- `bytesStored` — incremented on each `'download'` event
- `bytesServed` — incremented on each `'upload'` event
- DHT re-announcement via `setInterval()` at `announceInterval`

**Capacity check:**

```js
if (seeder.hasCapacity(additionalBytes)) {
  await seeder.seedCore(key)
}
```

**Stats:**

```js
seeder.getStats()
// { coresSeeded, totalBytesStored, totalBytesServed, capacityUsedPct }
```

---

## 8. Incentive Layer

### 8.1 Reputation System

**File:** `incentive/reputation/index.js` (230 lines)

Tracks relay performance across four axes with daily decay.

```js
import { ReputationSystem } from 'p2p-hiverelay'

const rep = new ReputationSystem()
```

**Scoring constants:**

| Input | Points | Constant |
|-------|--------|----------|
| Proof-of-relay pass | +10 | `CHALLENGE_WEIGHT` |
| Proof-of-relay fail | -20 | `CHALLENGE_WEIGHT * 2` |
| Bandwidth served | +0.001 / MB | `BANDWIDTH_WEIGHT` |
| Uptime | +1 / hour | `UPTIME_WEIGHT` |
| Geographic diversity bonus | +50 | `GEO_BONUS` |
| Daily decay multiplier | ×0.995 | `DECAY_RATE` |
| Minimum challenges for ranking | 10 | `MIN_CHALLENGES_FOR_RANKING` |

**Recording activity:**

```js
rep.recordChallenge(relayPubkeyHex, true, 1200)  // passed in 1200ms
rep.recordChallenge(relayPubkeyHex, false, 6000)  // failed (timeout)
rep.recordBandwidth(relayPubkeyHex, 1024 * 1024 * 100) // 100 MB served
rep.recordUptime(relayPubkeyHex, 24)  // 24 hours online
rep.applyGeoBonus(relayPubkeyHex, 'AF') // +50 if Africa is underserved
```

**Decay:** Call `rep.applyDecay()` daily. All scores are multiplied by 0.995, giving a half-life of approximately 139 days.

**Relay selection:**

```js
const bestRelays = rep.selectRelays(3, { geoPreference: ['EU'] })
// Returns array of 3 relay pubkeys, sorted by composite score
```

The composite score formula: `score × reliability × (1000 / avgLatencyMs)`. This balances raw reputation with consistency and responsiveness.

**Leaderboard:**

```js
const leaderboard = rep.getLeaderboard(50) // top 50
// [{ relay, score, reliability, avgLatencyMs, uptimeHours, bytesServed, region }]
```

Only relays with at least 10 challenges appear on the leaderboard (Sybil defense).

**Persistence:**

```js
const data = rep.export()  // Plain object
rep.import(data)           // Restore from saved state
```

### 8.2 Payment Manager

**File:** `incentive/payment/index.js` (228 lines)

Storj-inspired held-amount schedule for relay operator payments.

```js
import { PaymentManager } from 'p2p-hiverelay'

const pm = new PaymentManager(provider) // LightningProvider or MockProvider
```

**Held-amount schedule:**

| Month | Held % | Payout % |
|-------|--------|----------|
| 1–3 | 75% | 25% |
| 4–6 | 50% | 50% |
| 7–9 | 25% | 75% |
| 10+ | 0% | 100% |

**Methods:**

```js
pm.registerRelay(pubkeyHex, { region: 'NA', joinDate: Date.now() })
pm.recordEarnings(pubkeyHex, 5000) // 5000 sats earned
await pm.settle(pubkeyHex) // Trigger settlement via Lightning
pm.processHeldReturns(pubkeyHex) // Release held funds after vesting
pm.slash(pubkeyHex, 1000) // Penalty for misbehavior
```

**Pricing calculator:**

```js
PaymentManager.calculatePrice({
  storageMB: 1024,    // 1 GB stored
  bandwidthMB: 500,   // 500 MB transferred
  relayMB: 200,       // 200 MB relayed
  hours: 720          // 30 days
})
// Returns: { storageSats, bandwidthSats, relaySats, total }
```

**Rates:**
- Storage: 100 sats/GB/month
- Bandwidth: 50 sats/GB
- Relay: 75 sats/GB

### 8.3 Lightning Provider

**File:** `incentive/payment/lightning-provider.js` (202 lines)

LND gRPC integration for Bitcoin Lightning payments.

```js
import { LightningProvider } from 'p2p-hiverelay'

const ln = new LightningProvider({
  rpcUrl: 'localhost:10009',
  macaroonPath: '/path/to/admin.macaroon',
  certPath: '/path/to/tls.cert',
  network: 'mainnet'
})

await ln.connect()
const info = await ln.getInfo()
const balance = await ln.getBalance()
await ln.pay(invoiceString)
const invoice = await ln.createInvoice(1000, 'Relay payment')
await ln.disconnect()
```

### 8.4 Mock Provider

**File:** `incentive/payment/mock-provider.js` (82 lines)

In-memory payment provider for testing.

```js
import { MockProvider } from 'p2p-hiverelay'

const mock = new MockProvider({ initialBalance: 100_000 })
await mock.connect()
await mock.pay('lnbc...')
// mock.payments array tracks all transactions
```

---

## 9. Transport Plugins

### 9.1 WebSocket Transport

**File:** `transports/websocket/index.js` (100 lines)

Enables browser peers to connect to relay nodes.

```js
import { WebSocketTransport } from 'p2p-hiverelay'

const ws = new WebSocketTransport({
  port: 8765,
  maxConnections: 256,
  maxPayload: 64 * 1024 * 1024  // 64 MB
})

ws.on('connection', (stream, info) => {
  // stream is a WebSocketStream (Duplex)
  store.replicate(stream)
})

await ws.start()
// ...
await ws.stop()
```

### 9.2 WebSocket Stream

**File:** `transports/websocket/stream.js` (67 lines)

Wraps a WebSocket into a Node.js Duplex stream for Protomux compatibility.

```js
import { WebSocketStream } from 'p2p-hiverelay'

const stream = new WebSocketStream(ws)
// Use like any Duplex: stream.write(), stream.on('data'), pipe(), etc.
```

Handles backpressure: when the WebSocket buffer is full, the Duplex's write returns false, causing upstream to pause.

### 9.3 Tor Transport

**File:** `transports/tor/index.js` (366 lines)

Full Tor hidden service + SOCKS5 proxy transport for censorship resistance.

```js
import { TorTransport } from './transports/tor/index.js'

const tor = new TorTransport({
  socksHost: '127.0.0.1',
  socksPort: 9050,
  controlHost: '127.0.0.1',
  controlPort: 9051,
  controlPassword: null,        // or set password
  cookieAuthFile: '/var/lib/tor/control_auth_cookie',
  localPort: 9100               // port to forward hidden service to
})

await tor.start()
// tor.onionAddress → 'abc123...xyz.onion'

// Connect to a .onion address
const stream = await tor.connect('target.onion', 80)
// stream is a TorStream (Duplex), compatible with Hyperswarm

await tor.stop()
```

**Features:**
- Ephemeral hidden service via Tor control port (`ADD_ONION`)
- SOCKS5 outbound connections through Tor
- Cookie auth and password auth (with proper escaping to prevent control protocol injection)
- `TorStream` Duplex adapter wraps SOCKS5 sockets for Protomux compatibility
- Automatic connection tracking and cleanup

### 9.4 Holesail Transport

**File:** `transports/holesail/index.js`

TCP/UDP tunneling over Hyperswarm. Enables relay services to be exposed through NAT-traversing tunnels — any local port can be made accessible to peers on the network without port forwarding or static IPs. Built on the Holesail library which uses Hyperswarm for hole-punching.

---

## 10. HTTP API Reference

**File:** `core/relay-node/api.js` (135 lines)
**Base URL:** `http://127.0.0.1:9100` (localhost only)

The API uses Node.js built-in `http` module — no Express, no dependencies.

### `GET /health`

Health check.

```bash
curl http://localhost:9100/health
```

```json
{
  "ok": true,
  "uptime": {
    "ms": 170580000,
    "hours": 47.38,
    "human": "1d 23h 23m"
  },
  "running": true
}
```

### `GET /status`

Full node statistics.

```bash
curl http://localhost:9100/status
```

```json
{
  "running": true,
  "publicKey": "a1b2c3d4e5f6...",
  "seededApps": 3,
  "connections": 47,
  "relay": {
    "activeCircuits": 2,
    "totalCircuitsServed": 158,
    "totalBytesRelayed": 268435456,
    "capacityUsedPct": 1
  },
  "seeder": {
    "coresSeeded": 12,
    "totalBytesStored": 1073741824,
    "totalBytesServed": 536870912,
    "capacityUsedPct": 2
  }
}
```

### `GET /metrics`

Prometheus exposition format. Content-Type: `text/plain`.

```bash
curl http://localhost:9100/metrics
```

```
# HELP hiverelay_uptime_seconds Relay node uptime in seconds
# TYPE hiverelay_uptime_seconds gauge
hiverelay_uptime_seconds 3600
# HELP hiverelay_seeded_apps Number of apps being seeded
# TYPE hiverelay_seeded_apps gauge
hiverelay_seeded_apps 3
...
```

See [Prometheus Metrics](#11-prometheus-metrics) for full metric list.

### `GET /peers`

Connected peer list.

```bash
curl http://localhost:9100/peers
```

```json
{
  "count": 47,
  "peers": [
    { "remotePublicKey": "a1b2c3..." },
    { "remotePublicKey": "d4e5f6..." }
  ]
}
```

### `POST /seed`

Seed a Pear app by key.

```bash
curl -X POST http://localhost:9100/seed \
  -H "Content-Type: application/json" \
  -d '{"appKey": "a1b2c3d4e5f6..."}'
```

```json
{
  "ok": true,
  "discoveryKey": "f6e5d4c3..."
}
```

**Error (400):** `{"error": "Invalid app key: must be 64 hex characters"}`

### `POST /unseed`

Stop seeding an app (operator endpoint, no auth required).

```bash
curl -X POST http://localhost:9100/unseed \
  -H "Content-Type: application/json" \
  -d '{"appKey": "a1b2c3d4e5f6..."}'
```

```json
{ "ok": true }
```

### `POST /api/v1/unseed`

Developer kill switch — remotely unseed your app from this relay and broadcast to the network. Requires Ed25519 signature proving publisher ownership.

```bash
curl -X POST http://relay:9100/api/v1/unseed \
  -H "Content-Type: application/json" \
  -d '{
    "appKey": "a1b2c3d4e5f6...",
    "publisherPubkey": "your-pubkey-hex...",
    "signature": "ed25519-signature-hex...",
    "timestamp": 1713100000000
  }'
```

**Signature format:** Sign `(appKey + 'unseed' + uint64_be(timestamp))` with your Ed25519 secret key.

**Security:** Timestamp must be within 5 minutes. Signature is verified against the `publisherPubkey` stored when the app was originally seeded. The unseed is propagated to all connected relays via P2P.

```json
{ "ok": true, "message": "App unseeded and unseed broadcast to network" }
```

**Errors:** `403 PUBLISHER_MISMATCH` (wrong key), `403 INVALID_SIGNATURE`, `403 STALE_TIMESTAMP`, `403 APP_NOT_FOUND`

### Management API

Live management endpoints used by `hiverelay manage` TUI. All changes are hot-applied and persisted to disk.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/manage/config` | GET | Current config + operating mode |
| `/api/manage/config` | POST | Update config values (maxStorageBytes, maxConnections, maxRelayBandwidthMbps, regions, etc.) |
| `/api/manage/services` | GET | All services with running status, methods, and stats |
| `/api/manage/services` | POST | `{ action: "disable"|"restart", service: "name" }` |
| `/api/manage/transports` | GET | Transport status (holesail, tor, websocket) |
| `/api/manage/transport` | POST | `{ transport: "holesail"|"tor"|"websocket", enabled: true|false }` |
| `/api/manage/modes` | GET | Available operating modes with descriptions |
| `/api/manage/mode` | POST | `{ mode: "standard"|"homehive"|"seed-only"|"relay-only"|"stealth"|"gateway" }` |
| `/api/manage/restart` | POST | Graceful node restart |
| `/api/manage/shutdown` | POST | Graceful shutdown |

### Error Responses

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request (missing appKey, invalid hex) |
| 404 | Unknown endpoint |
| 500 | Internal error |
| 503 | Metrics/services not enabled |

---

## 11. Prometheus Metrics

**File:** `core/relay-node/metrics.js` (142 lines)

All metrics are exported at `/metrics` in Prometheus exposition format.

### Gauge Metrics (current value)

| Metric | Description |
|--------|-------------|
| `hiverelay_uptime_seconds` | Node uptime in seconds |
| `hiverelay_seeded_apps` | Number of apps being seeded |
| `hiverelay_connections` | Active peer connections |
| `hiverelay_cores_seeded` | Number of Hypercores being seeded |
| `hiverelay_bytes_stored` | Total bytes stored |
| `hiverelay_active_circuits` | Active relay circuits |
| `hiverelay_process_heap_bytes` | Process heap memory (bytes) |
| `hiverelay_process_rss_bytes` | Process RSS memory (bytes) |

### Counter Metrics (cumulative)

| Metric | Description |
|--------|-------------|
| `hiverelay_bytes_served` | Total bytes served to peers |
| `hiverelay_total_circuits_served` | Total circuits served |
| `hiverelay_bytes_relayed` | Total bytes relayed |
| `hiverelay_errors_total` | Total connection errors |

### Snapshot Buffer

Metrics internally maintains a circular buffer of 1,440 minutely snapshots (24 hours). The buffer uses O(1) insertion by overwriting at a rotating head index.

```js
// Access snapshots programmatically
node.metrics.snapshots     // Array of historical snapshots
node.metrics.getSummary()  // { uptime, current: stats, snapshotCount }
```

### Grafana Integration

Add to your Prometheus `scrape_configs`:

```yaml
scrape_configs:
  - job_name: 'hiverelay'
    static_configs:
      - targets: ['localhost:9100']
    metrics_path: '/metrics'
    scrape_interval: 60s
```

---

## 12. CLI Reference

**File:** `cli/index.js`
**Binary:** `hiverelay` or `p2p-hiverelay` (via package.json `bin` field)

### `hiverelay setup`

Interactive setup wizard (TUI). Guides new operators through full node configuration.

```bash
hiverelay setup
```

**What it configures:**
1. **Node profile** — Light (Pi/laptop), Standard (VPS), Heavy (dedicated), or Custom
2. **Storage path** and resource limits (storage, connections, bandwidth)
3. **Services** — checkbox selection of all 8 services
4. **Core features** — relay, seeding, auto-accept toggle
5. **Network** — API port, region filters
6. **Transports** — Holesail (NAT), Tor (hidden service), WebSocket
7. **Lightning payments** — LND config and network selection
8. **Advanced** — circuit limits, proof latency, bootstrap nodes, shutdown timeout

Saves to `~/.hiverelay/config.json` and optionally starts the node immediately.

### `hiverelay manage`

Live management console (TUI). Connects to a running node's HTTP API for interactive control.

```bash
hiverelay manage [--host <ip>] [--port <n>]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--host <ip>` | Relay host address | `127.0.0.1` |
| `--port <n>` | Relay API port | `9100` |

**Management menus:**

| Menu | What You Can Do |
|------|----------------|
| Dashboard | Live status — uptime, connections, storage, memory, peers, services |
| Services | Enable/disable/restart individual services, view methods and stats |
| Resources | Adjust storage, connections, bandwidth limits (hot-applied, persisted) |
| Transports | Toggle Holesail/Tor/WebSocket on/off |
| Seeding & Apps | Seed/unseed apps, view catalog, toggle auto-accept |
| Operating Mode | Switch between Standard, HomeHive, Seed-Only, Relay-Only, Stealth, Gateway |
| Network | Update regions, view peers with reputation scores |
| Security | Toggle approval mode, approve/reject pending seed requests |
| Payments | View bandwidth receipts, Lightning status |
| Relay Settings | Circuit limits, proof-of-relay config |
| Advanced | Shutdown timeout, announce interval, export config |
| Update Software | Check npm for latest version, restart after update |

All changes are applied immediately to the running node and persisted to `~/.hiverelay/config.json`.

### `hiverelay init`

Lightweight first-time setup. Creates config directory, generates defaults, and auto-installs agent skills. For full interactive configuration, use `hiverelay setup` instead.

```bash
hiverelay init [--region <code>] [--max-storage <size>]
```

**What it does:**
1. Creates `~/.hiverelay/` directory structure
2. Writes `~/.hiverelay/config.json` with defaults + overrides
3. Detects Hermes (`~/.hermes`) and OpenClaw (`~/.openclaw` or `/opt/homebrew/...`)
4. Copies `SKILL.md` to detected agent frameworks
5. Copies OpenClaw TypeScript plugin if applicable

### `hiverelay start`

Start a relay node with full configuration.

```bash
hiverelay start [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--storage <path>` | Storage directory | `~/.hiverelay/storage` |
| `--max-storage <size>` | Max storage (e.g., `50GB`) | `50GB` |
| `--max-connections <n>` | Max peer connections | `256` |
| `--max-bandwidth <mbps>` | Max relay bandwidth | `100` |
| `--region <code>` | Region code | all |
| `--port <n>` | HTTP API port | `9100` |
| `--seed <key>` | Seed an app on startup | — |
| `--no-relay` | Disable circuit relay | enabled |
| `--no-seeding` | Disable app seeding | enabled |
| `--no-api` | Disable HTTP API | enabled |
| `--no-metrics` | Disable Prometheus metrics | enabled |
| `--tor [password]` | Enable Tor hidden service | disabled |
| `--holesail` | Enable Holesail NAT tunnel | disabled |
| `--quiet` | Suppress periodic status output | — |

**Config precedence:** CLI flags > `~/.hiverelay/config.json` > built-in defaults.

**Status line:** Unless `--quiet`, prints a status bar every 5 seconds:

```
[status] Apps: 3 | Conns: 47 | Stored: 4.2 GB | Served: 891.0 MB | Circuits: 2
```

**Shutdown:** Ctrl+C triggers graceful shutdown via `graceful-goodbye`.

### `hiverelay seed <key>`

Request seeding for a Pear app key.

```bash
hiverelay seed a1b2c3d4e5f6... [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--replicas <n>` | Replication factor | `3` |
| `--geo <region>` | Geographic preference | any |
| `--max-storage <size>` | Max storage for this app | `500MB` |
| `--ttl <days>` | Seed request TTL | `30` |

### `hiverelay status`

Query a running node's status via the HTTP API.

```bash
hiverelay status [--port <n>]
```

### `hiverelay help`

Show help text with all commands and options.

### Byte Parsing

The CLI supports human-readable byte sizes: `B`, `KB`, `MB`, `GB`, `TB` (case-insensitive). Examples: `50GB`, `500MB`, `1.5TB`.

---

## 13. Configuration

**Files:** `config/default.js` (69 lines), `config/loader.js` (72 lines)

### Default Configuration

```js
{
  // Storage
  storage: './hiverelay-storage',

  // Network
  bootstrapNodes: null,   // null = HyperDHT defaults (node1-3.hyperdht.org:49737)
  maxConnections: 256,

  // Seeding
  enableSeeding: true,
  maxStorageBytes: 53687091200,       // 50 GB
  announceInterval: 900000,           // 15 minutes

  // Circuit Relay
  enableRelay: true,
  maxRelayBandwidthMbps: 100,
  maxCircuitDuration: 600000,         // 10 minutes
  maxCircuitBytes: 67108864,          // 64 MB per circuit
  maxCircuitsPerPeer: 5,
  reservationTTL: 3600000,            // 1 hour

  // Proof-of-Relay
  proofMaxLatencyMs: 5000,
  proofChallengeInterval: 300000,     // 5 minutes

  // Reputation
  reputationDecayRate: 0.995,         // Daily
  minChallengesForRanking: 10,

  // API & Metrics
  enableMetrics: true,
  enableAPI: true,
  apiPort: 9100,

  // Regions
  regions: [],                        // Empty = all regions

  // Transports
  transports: {
    udp: true,       // Always on (HyperDHT)
    tor: false,
    websocket: false,
    holesail: false
  },
  wsPort: 8765,

  // Lightning Payments
  lightning: {
    enabled: false,
    rpcUrl: 'localhost:10009',
    macaroonPath: null,
    certPath: null,
    network: 'mainnet'
  },

  // Payment Settlement
  payment: {
    enabled: false,
    settlementInterval: 86400000,     // 24 hours
    minSettlementSats: 1000
  },

  // Shutdown
  shutdownTimeoutMs: 10000
}
```

### Config Loader

The loader merges three levels of configuration:

```
CLI flags (highest priority)
    ↓
~/.hiverelay/config.json
    ↓
Built-in defaults (config/default.js)
```

```js
import { loadConfig, saveConfig, ensureDirs } from 'p2p-hiverelay/config/loader.js'

ensureDirs()                    // Creates ~/.hiverelay/ and subdirectories
const config = loadConfig({     // Merge: overrides > file > defaults
  apiPort: 9200,
  maxStorageBytes: 100 * 1024**3
})
saveConfig(config)              // Write to ~/.hiverelay/config.json
```

### Config File Location

```
~/.hiverelay/
├── config.json       # User configuration
├── storage/          # Hypercore data (default)
└── keys/             # Ed25519 keypair (if generated)
```

---

## 14. Agent Integration

### SKILL.md (Hermes / OpenClaw)

**File:** `skills/SKILL.md` (169 lines)

The skill definition follows the agentskills.io specification. It provides:

| Command | Description |
|---------|-------------|
| `/hiverelay start` | Start a relay node |
| `/hiverelay stop` | Stop the running node |
| `/hiverelay status` | Show node statistics |
| `/hiverelay seed <key>` | Seed a Pear app |
| `/hiverelay health` | Quick health check |

The `hiverelay init` command auto-detects installed agent frameworks and installs the skill:
- **Hermes:** `~/.hermes/skills/hiverelay/SKILL.md`
- **OpenClaw:** `~/.openclaw/skills/hiverelay/SKILL.md`

### OpenClaw TypeScript Plugin

**File:** `plugins/openclaw/index.ts` (162 lines)

Provides in-process control tools for OpenClaw:

```typescript
// Tools exposed to OpenClaw
hiverelay_start()   // Start relay via child_process
hiverelay_stop()    // Stop relay
hiverelay_seed()    // Seed an app key
hiverelay_status()  // Query /status API
hiverelay_metrics() // Query /metrics API
hiverelay_health()  // Query /health API
```

The plugin communicates with the relay node via the HTTP API, so the node must be running.

---

## 15. Testing

### Test Framework

HiveRelay uses [Brittle](https://github.com/holepunchto/brittle) — a lightweight tap-compatible test framework from the Holepunch ecosystem.

### Running Tests

```bash
npm test                    # All tests
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests only
```

### Test Structure

```
test/
├── unit/
│   ├── bandwidth-receipt.test.js   # 123 lines — Receipt creation, verification, collection
│   ├── client.test.js              # 226 lines — Client simple/advanced mode, swarm integration
│   ├── lightning-provider.test.js  # 191 lines — MockProvider, PaymentManager integration
│   ├── payment.test.js             # 75 lines — Registration, earnings, holds, settlements
│   ├── proof-of-relay.test.js      # 148 lines — Challenges, responses, latency, scoring
│   ├── relay.test.js               # 149 lines — Circuit creation, byte limits, backpressure
│   ├── relay-node.test.js          # 53 lines — Node initialization, startup, stats
│   ├── reputation.test.js          # 82 lines — Scoring, decay, leaderboard, selection
│   └── websocket-transport.test.js # 207 lines — Connectivity, binary data, capacity limits
└── integration/
    ├── client.test.js              # 175 lines — Client discovery, seeding, multi-client
    └── network.test.js             # 432 lines — 2/3-node networks, replication, API, lifecycle
```

### Test Coverage

- **71 unit tests** (189 assertions) — Protocols, transport, payment, client
- **15 integration tests** — Multi-node discovery, replication, API, mesh
- **24-check MVN test** — 3 relay nodes + 2 clients, full end-to-end

### Integration Tests

Integration tests use `@hyperswarm/testnet` to create isolated DHT networks:

```js
import { createTestnet } from '@hyperswarm/testnet'

const testnet = await createTestnet(3) // 3 bootstrap nodes
const node = new RelayNode({
  bootstrapNodes: testnet.bootstrap,
  storage: './test-storage'
})
```

### MVN Test (Minimum Viable Network)

**File:** `scripts/mvn-test.js` (298 lines)

End-to-end test that validates the complete workflow:

1. Starts 3 relay nodes on isolated testnet
2. Client A publishes a Hyperdrive with test files
3. Client A requests seeding (SDK broadcast + HTTP API)
4. Client B discovers relays and replicates content
5. Verifies all HTTP API endpoints (`/health`, `/status`, `/metrics`)
6. Verifies relay mesh connectivity
7. Reports pass/fail with detailed assertions

```bash
node scripts/mvn-test.js
```

### Local Network Script

**File:** `scripts/local-network.js` (182 lines)

Interactive development tool that spins up a configurable number of relay nodes:

```bash
node scripts/local-network.js          # Default: 3 nodes
node scripts/local-network.js --nodes 5 # Custom count
```

Each node gets isolated storage and a unique API port (9100, 9101, 9102, ...). Status updates print every 10 seconds. Press Ctrl+C for graceful shutdown.

---

## 16. Security Model

### Cryptographic Primitives

| Purpose | Algorithm | Library |
|---------|-----------|---------|
| Identity | Ed25519 keypairs | `sodium-universal` |
| Transport encryption | Noise_XX | HyperDHT (built-in) |
| Message signing | `crypto_sign_detached` | `sodium-universal` |
| Signature verification | `crypto_sign_verify_detached` | `sodium-universal` |
| Hashing | BLAKE2b (`crypto_generichash`) | `sodium-universal` |
| Random nonces | `randombytes_buf` (32 bytes) | `sodium-universal` |
| Merkle proofs | BLAKE2b tree | Hypercore (built-in) |

### Security Properties

**Identity:** Every node has an Ed25519 keypair. The public key is the node's identity on the DHT. All seed requests, acceptances, and receipts are signed.

**Transport encryption:** All connections use Noise_XX via HyperDHT. Data is encrypted end-to-end between peers. The relay node sees only opaque ciphertext when forwarding circuit relay traffic.

**Replay prevention:** Every proof-of-relay challenge includes a 32-byte random nonce generated via `sodium.randombytes_buf()` (not timestamps). The relay must echo the nonce in its response. Stale challenges are auto-cleaned every 30 seconds. Bandwidth receipts include replay detection with a circular buffer of 50,000 seen nonces.

**Circuit privacy:** The relay forwards opaque bytes. It cannot decrypt, inspect, or modify circuit traffic. E2E encryption is maintained between the source and destination peers.

**Sybil resistance:** The leaderboard requires a minimum of 10 proof-of-relay challenges before a node is ranked. Daily score decay (0.995) means idle or abandoned nodes lose reputation over time. The asymmetric penalty (-20 for failure vs +10 for success) makes attacks costly.

**Input validation:**
- Hex keys: exactly 64 characters matching `/^[0-9a-f]+$/i`, normalized to lowercase
- AppId: max 128 chars, `/^[a-zA-Z0-9._-]+$/`
- Version: max 32 chars
- Request body: max 64KB
- All keys normalized to lowercase to prevent duplicate entries

**Atomic persistence:** All JSON state files use tmp-file + rename pattern:
- `app-registry.json` — persistent app registry
- `seeded-apps.json` — seeded app state
- `encryption-keys.json` — blind mode encryption keys (0o600 permissions)

This prevents data corruption on power loss or crash.

**Rate limiting:**
- HTTP API: 60 req/min per IP (token bucket)
- P2P protocol: token bucket rate limiter per peer key (`core/protocol/rate-limiter.js`)
- Directory listings: max 1000 entries with timeout

**Path traversal protection (Hyper Gateway):**
- Blocks `..` in decoded and double-decoded paths
- Blocks null bytes (`\x00`)
- Blocks Windows absolute paths (`C:`)
- Drive keys validated as exactly 64 hex characters

### API Authentication (Optional)

For private relay operators, API authentication can be enabled:

```bash
export HIVERELAY_API_KEY=$(openssl rand -hex 32)
```

When set, write endpoints require `Authorization: Bearer <key>`. Auth behavior:

| `HIVERELAY_API_KEY` | Behavior |
|---------------------|----------|
| Not set (default) | Auth disabled — open relay |
| Set to value | All write endpoints require Bearer token |

**Note:** Public relays do NOT use API keys. Rate limiting and storage caps prevent abuse.

---

## 17. Platform Privacy APIs

The `platform/` directory provides privacy primitives for Pear app developers. These APIs implement the tiered privacy model described in the HiveRelay Privacy Architecture Specification.

### 17.1 Privacy Tiers

Apps declare a privacy tier in their manifest. The `PrivacyManager` enforces the tier's rules:

| Tier | Relay Sees | Data Location | Sync | Encryption |
|------|-----------|---------------|------|------------|
| `public` | All data | Relay (cached) | Via relay | None |
| `local-first` | App code only | Device | P2P only | XChaCha20-Poly1305 |
| `p2p-only` | Nothing | Device | P2P only | XChaCha20-Poly1305 |

### 17.2 PolicyGuard (Relay-Side Enforcement)

While `PrivacyManager` runs on the client/app side, **PolicyGuard** (`core/policy-guard.js`) enforces privacy tiers on the relay itself. It ensures the relay never stores or serves data that violates an app's declared tier.

**Single constraint:** Does the relay's exposure level match what this tier allows?

```
RELAY_EXPOSURE:
  public      → 'full'      (relay sees code + user data)
  local-first → 'code-only' (relay sees app code, never user data)
  p2p-only    → 'none'      (relay touches nothing)
```

**Operations checked:**
- `serve-code` — Is the relay allowed to serve this app? (blocked for p2p-only)
- `store-on-relay` — Is the relay allowed to store data? (blocked for local-first, p2p-only)
- `replicate-user-data` — Can user data flow through? (allowed only for public)

**Enforcement points in RelayNode:**
1. `seedApp()` — Before any data is stored (pre-storage gate)
2. `_indexAppManifest()` — After reading manifest (serve-code permission)
3. `StorageService.drive-write / core-append` — RPC write operations

**Violation behavior:**
- Immediate suspension (not a warning)
- App is unseeded from the relay
- All future operations blocked for that appKey
- Operator must manually call `reinstate(appKey)` after reviewing

**API endpoints:**
- `GET /api/policy/violations` — List all suspended apps
- `POST /api/policy/reinstate` — Reinstate a suspended app (requires API key)

**Events emitted:**
- `policy-violation` — On suspension (includes appKey, tier, reason)
- `reinstated` — When operator reinstates

### 17.3 Crypto API (`platform/crypto.js`)

All encryption uses `sodium-universal` (libsodium):

| Function | Algorithm | Purpose |
|----------|-----------|---------|
| `encrypt(plaintext, key)` | XChaCha20-Poly1305 (AEAD) | Symmetric encryption with 24-byte nonce |
| `decrypt(sealed, key)` | XChaCha20-Poly1305 | Decryption with authentication |
| `hash(data)` | BLAKE2b (32-byte output) | Hashing |
| `hashKeyed(data, key)` | BLAKE2b with key (MAC) | Keyed hash / MAC |
| `generateKey()` | CSPRNG | Generate 32-byte encryption key |
| `randomBytes(n)` | CSPRNG | Generate n random bytes |
| `equal(a, b)` | Constant-time compare | Timing-safe equality check |

### 17.3 Key Management (`platform/keys.js`)

Hierarchical key derivation using BLAKE2b keyed hashing:

```
deviceKey (root — persisted to disk, 0o600 permissions)
  └── appKey("sanduq") = BLAKE2b(deviceKey, "app:sanduq")
        ├── dataKey("transactions") = BLAKE2b(appKey, "data:transactions")
        ├── dataKey("profile") = BLAKE2b(appKey, "data:profile")
        └── syncKey("peer-abc") = BLAKE2b(appKey, "sync:peer-abc")
```

Key material is zeroed on `destroy()` via `sodium.sodium_memzero()`.

### 17.4 Local Storage (`platform/storage.js`)

Encrypted key-value storage on the local device:

- Data encrypted at rest with XChaCha20-Poly1305
- Atomic writes (tmp + rename) prevent corruption
- Per-app namespace isolation
- Configurable quota (default 100MB)
- `exportEncrypted()` / `importEncrypted()` for P2P backup sync

### 17.5 Privacy Manager (`platform/privacy.js`)

Wraps all platform APIs with tier enforcement:

- `store(key, value)` — encrypts and stores locally (local-first/p2p-only) or returns plaintext for relay (public)
- `retrieve(key)` — decrypts and returns local data
- `prepareSyncExport()` — exports encrypted blobs for P2P backup
- `validateOperation(op)` — checks if an operation is allowed for the current tier
- `getPrivacyReport()` — audit summary showing encrypted vs plaintext stores, warnings, relay exposure
- `encryptForTransit(data)` / `decryptFromTransit(sealed)` — encrypt data for blind mode relay storage
- `driveEncryptionKey()` — returns the Hyperdrive encryption key (null for public tier)

### 17.6 Standalone Reference Implementation (`standalone/`)

A complete P2P block storage server/client using pure Hyperswarm — no relay involved. Demonstrates the Tier 3 (P2P-Only) pattern:

```bash
cd standalone && npm install
npm run demo    # Self-contained demo (1500+ blocks/sec)
npm test        # 10 tests
npm run server  # Start server (prints public key)
npm run client <key>  # Connect with interactive REPL
```

See `standalone/ARCHITECTURE.md` for the full technical explainer with diagrams.

### Ownership Signatures (Opt-in)

When provided in seed/unseed requests, Ed25519 ownership signatures are verified:

```json
{
  "appKey": "64-hex-chars",
  "ownershipSignature": "signature-of-appKey-using-private-key",
  "ownerPublicKey": "ed25519-public-key-hex"
}
```

Verified via `sodium.crypto_sign_verify_detached`. If the signature is provided and invalid, the request is rejected with 403. If not provided, the request proceeds normally (backward compatible).

### Registration Challenges (Opt-in)

To prevent appId squatting, a SHA256 proof-of-work challenge system is available:

1. `POST /challenge` with `{ "appId": "my-app" }` — returns a random challenge (expires in 5 min)
2. Client solves: `SHA256(challenge + appId)`
3. Include `registrationChallenge` in the seed request

Challenges are verified only when provided. If not provided, the request proceeds normally.

**Bounded resources:**
- Receipts: circular buffer, 50,000 nonce replay detection
- Circuits: capped at 256 total, 5 per peer
- Circuit bytes: 64 MB max
- Circuit duration: 10 minutes max
- Metrics buffer: 1,440 snapshots (24 hours, circular)
- Stale challenge cleanup: every 30 seconds
- Blind app registrations: max 500 (configurable)
- Drive cache (gateway): max 50, LRU eviction
- Drive operation timeout: 30 seconds (configurable)

---

## 17. Deployment Guide

### System Requirements

- **Node.js:** >= 20.0.0
- **RAM:** 256 MB minimum, 1 GB recommended
- **Storage:** Configurable (default 50 GB max)
- **Network:** UDP port access (HyperDHT), optionally TCP 8765 (WebSocket), TCP 9100 (API)

### Production Setup

```bash
# 1. Install
git clone https://github.com/hiverelay/hiverelay.git
cd hiverelay
npm install --production

# 2. Initialize
hiverelay init --region EU --max-storage 100GB

# 3. Configure (edit ~/.hiverelay/config.json as needed)

# 4. Start with process manager
# Option A: systemd
sudo cp hiverelay.service /etc/systemd/system/
sudo systemctl enable hiverelay
sudo systemctl start hiverelay

# Option B: pm2
pm2 start cli/index.js --name hiverelay -- start --region EU

# 5. Verify
curl http://localhost:9100/health
```

### Example systemd Service

```ini
[Unit]
Description=HiveRelay Node
After=network.target

[Service]
Type=simple
User=hiverelay
WorkingDirectory=/opt/hiverelay
ExecStart=/usr/bin/node cli/index.js start
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Monitoring

1. Configure Prometheus to scrape `localhost:9100/metrics`
2. Import Grafana dashboard (see metrics section above)
3. Set alerts on:
   - `hiverelay_errors_total` increasing
   - `hiverelay_process_rss_bytes` exceeding threshold
   - `hiverelay_connections` dropping to zero

### TLS with Caddy (Recommended)

```bash
# Install Caddy and configure
sudo tee /etc/caddy/Caddyfile <<'EOF'
relay.yourdomain.com {
    reverse_proxy 127.0.0.1:9100
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
    }
}
EOF
sudo systemctl restart caddy
```

Caddy auto-obtains TLS certificates via Let's Encrypt. See `PRODUCTION.md` for full details.

### Firewall Rules

```bash
# HyperDHT (required)
# UDP is handled by HyperDHT hole-punching — no inbound rules needed for most setups

# HTTP API — bind is 0.0.0.0 by default for remote access
# Use Caddy/NGINX as TLS-terminating reverse proxy in production

# HTTPS (if using Caddy/NGINX)
ufw allow 443/tcp

# WebSocket (optional, if enabled)
ufw allow 8765/tcp  # Only if transports.websocket = true
```

---

## 18. Troubleshooting

### Node Won't Start

**Error: "port 9100 already in use"**
Another instance is already running or another service uses port 9100. Use `--port 9101` or stop the other process.

**Error: "EACCES: permission denied" on storage path**
The storage directory isn't writable. Check permissions or use `--storage /path/to/writable/dir`.

**Startup rollback**: If you see "Startup failed" — the node has already cleaned up. Check the error message and fix the issue, then retry.

### No Peers Connecting

1. Check internet connectivity
2. Verify UDP is not blocked by firewall
3. Try custom bootstrap nodes: `--bootstrap node1.example.com:49737`
4. Check `curl localhost:9100/peers` — if count is 0 after 30s, there may be a NAT issue

### Seed Requests Not Accepted

1. Verify at least 3 relay nodes are connected: `app.getRelays().length`
2. Check that the app key is valid 64-char hex
3. Increase timeout: `app.seed(key, { timeout: 30_000 })`
4. Check relay capacity: seed requests are rejected if storage is full

### High Memory Usage

1. Check `hiverelay_process_heap_bytes` metric
2. Reduce `maxConnections` (default 256)
3. Reduce `maxStorageBytes`
4. Receipts are bounded at 10,000 — shouldn't cause issues
5. Check for circuit relay accumulation: `hiverelay_active_circuits`

### Circuit Relay Failures

1. Circuit limit: 5 per peer, 256 total
2. Byte limit: 64 MB per circuit
3. Time limit: 10 minutes per circuit
4. Backpressure: if destination is slow, source is paused — not failed

### API Not Responding

1. Check that `enableAPI` is true (default)
2. Verify port: `curl http://localhost:9100/health`
3. API only binds to `127.0.0.1` — not accessible remotely by design
4. Check if metrics are enabled: `/metrics` returns 503 if `enableMetrics` is false

---

## Appendix: Rollout Phases

### Phase 1 (Current)

Community relay network. No money. Operators earn reputation through proof-of-relay. Goal: prove the protocol works, build an operator community.

### Phase 2 (Infrastructure Ready)

Direct Lightning payments. Developers pay relays in Bitcoin. Held-amount schedule ensures operator commitment (75% held months 1-3, tapering to 0%). The payment infrastructure is fully built and tested — waiting for demand.

### Phase 3 (Future)

Optional HIVE token if organic demand justifies it. Work-token model, quadratic staking, geographic diversity multipliers. Retroactive rewards for Phase 1-2 operators.

See `docs/ECONOMICS.md` for the complete token economics and incentive design (1,198 lines).
