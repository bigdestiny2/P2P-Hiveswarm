# HiveRelay

**Always-on relay infrastructure for the Pear & Hyperswarm ecosystem.**

**Open source (Apache 2.0)** | **[GitHub](https://github.com/bigdestiny2/P2P-Hiverelay)** | **[npm](https://www.npmjs.com/package/p2p-hiverelay)** | **Status: v0.5.x stable, v0.6.0 in pipeline**

> The relay layer of the Hive substrate — blind, always-on, paid in Lightning sats. The consumer-facing Umbrel App Store version is branded **Blindspark**. The protocol and SDK retain the HiveRelay name.

---

## The Problem

You build a P2P app on Hyperswarm. It works beautifully — until you close your laptop. Then your users see "offline" and your app is dead. Mobile users behind carrier NATs can't connect at all. Browser users can't use UDP. There's no persistence, no discovery, no payment rail, and no services backend.

## The Fix

HiveRelay gives your app always-on availability, NAT traversal, browser access, app discovery, AI inference, identity, and a services layer — without running your own servers.

```js
import { HiveRelayClient } from 'p2p-hiverelay-client'

const app = new HiveRelayClient('./my-app-storage')
await app.start()

const drive = await app.publish('./my-app')
// Close your laptop. Your app stays online via the relay network.
```

Works in **Pear/Bare runtime** natively:

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay-client'

const store = new Corestore(Pear.config.storage)
const app = new HiveRelayClient({ swarm: new Hyperswarm(), store })
await app.start()
```

> See **[docs/PEAR-INTEGRATION.md](docs/PEAR-INTEGRATION.md)** for full Pear/Bare usage.
> See **[examples/pear-app/](examples/pear-app/)** and **[examples/node-app/](examples/node-app/)** for working starter projects.

---

## What's new since v0.4.2

### v0.6.0 (in pipeline — `feat/umbrel-app` branch)
- **Umbrel App Store package** — one-click install for Umbrel users; consumer brand: Blindspark
- **5-step setup wizard** — auto-detects LNbits, encrypts the admin key at rest, sane defaults
- **Comprehensive threat-model security work** — quorum-diverse reads, automatic fork detection during replication, signed observer attestations on fork proofs, capability-doc signing, audit trail for security overrides
- **`@hive/verifier` package** — standalone reference verifier for cross-client verification
- **Per-endpoint rate limiting** on sensitive paths
- **Strategic docs**: `THREAT-MODEL.md`, `SECURITY-STRATEGY.md`, `OPERATOR-INCENTIVES-Y1.md`, `M2-ROADMAP.md`

### v0.5.1
- **Capability advertisement** at `/.well-known/hiverelay.json` — machine-readable relay metadata
- **Machine-readable error prefixes** — clients can branch on failure type
- **Author seeding manifests** — Ed25519-signed "fetch my drives from these relays"

### v0.5.0
- **Monorepo split** into `packages/{core, services, client}` workspaces
- **First-class Pear/Bare runtime support** — both runtimes interoperate
- **Per-relay accept-modes** (`open` / `review` / `allowlist` / `closed`) replacing auto-sync
- **Federation primitive** — explicit cross-relay catalog sharing
- **DHT-over-WebSocket transport** for browser clients
- **Multi-device pairing** via 6-digit zero-knowledge code
- **Delegation certs with revocation**

---

## What Your App Gets

### Blind Peering — The Killer Feature

Relays store and replicate your data **encrypted**. They can't read it. They just keep it online.

```js
const drive = await client.publish('./my-app', {
  encryptionKey: myKey  // 32-byte key — relay stores ciphertext only
})
```

- Relay stores opaque encrypted blocks — it literally cannot decrypt your data
- HTTP gateway returns 403 for blind apps ("P2P access only")
- Your app appears in the catalog for discovery (name + key), but content requires the encryption key
- Peers connect directly via Hyperswarm with the key to read
- Circuit relay bridges encrypted streams without decryption — relay sees only bytes

This is what production P2P apps need: **always-on persistence without trusting the relay operator.** Your medical records app, your wallet, your private messaging — stays online 24/7 across multiple regions, and no relay operator can read a single byte.

### Diverse-Quorum Reads (v0.6.0)

Your client doesn't trust a single relay. It picks a quorum of geographically + organizationally diverse relays, queries them in parallel, and detects when any disagree.

```js
await client.refreshCapabilityCache(relayUrls)
const quorum = client.selectQuorum({ size: 5, minRegions: 3 })
const result = await client.queryQuorumWithComparison('/api/info', quorum, {
  compareFields: ['length', 'version'],
  driveKey
})
if (result.divergent.length > 0) {
  // Fork detected — drive auto-quarantined; operator must resolve
}
```

### Automatic Fork Detection (v0.6.0)

When `client.open(driveKey)` succeeds, the client auto-attaches Hypercore listeners that detect equivocation during replication. Forked drives are quarantined; opening one again throws `DRIVE_QUARANTINED` until the operator explicitly resolves.

### Capability-Doc Signed by Relay Identity (v0.6.0)

`/.well-known/hiverelay.json` is now signed by the relay's identity Ed25519 key. The client auto-verifies on fetch. A reverse proxy or MITM that tampers with the doc is detected.

```js
const caps = await client.fetchCapabilities('https://relay.example.com:9100', {
  expectedPubkey: '<known-relay-pubkey>'  // out-of-band trust pinning
})
```

### Always-On Availability
Publish once, relay nodes across multiple continents serve it 24/7. You go to sleep, your users don't notice. If a relay goes down, others still serve your data.

### Every User Can Connect
The ~5% of connections that fail hole-punching get bridged through encrypted circuit relays automatically.

### Developer Kill Switch
Changed your mind? Ship a bad version? Unseed your app from the entire network with one signed call:

```js
await app.unseed(driveKey)  // Ed25519 signed — relays verify you're the publisher
```

### Author Seeding Manifests (v0.5.1)

Authors publish a signed list of "fetch my drives from these relays":

```js
const manifest = client.createSeedingManifest({
  relays: [
    { url: 'hyperswarm://abc...', role: 'primary' },
    { url: 'wss://relay.example.com/dht', role: 'backup' }
  ],
  drives: [{ driveKey: '...', channel: 'production' }]
})
await client.publishSeedingManifest('https://relay.example.com:9100', manifest)
```

Anyone can fetch (and verify the signature on) the manifest at `/api/authors/<pubkey>/seeding.json`.

### Dual Transport: P2P + HTTP
Same app, same data, accessible two ways:

| Scenario | P2P (Hyperswarm) | HTTP (Gateway) |
|----------|-------------------|----------------|
| Pear desktop app | Direct P2P | Also browsable via gateway |
| Browser / web app (no UDP) | DHT-over-WebSocket transport | Works via gateway |
| Mobile on carrier NAT | Circuit relay bridges it | Works via HTTP |
| curl / scripts / CI | Complex | Simple REST calls |
| Privacy-sensitive (blind mode) | Full P2P with encryption key | Gateway returns 403 |

---

## Client SDK

```bash
npm install p2p-hiverelay-client
```

### Content API

| Method | Description |
|--------|-------------|
| `app.publish(dir)` | Publish a directory to a Hyperdrive |
| `app.open(key, opts)` | Open and replicate a remote drive (refuses quarantined drives unless `opts.force`) |
| `app.get(key, path)` | Read a file from a drive |
| `app.put(key, path, content)` | Write a file to a drive |
| `app.list(key, dir)` | List directory contents |
| `app.closeDrive(key)` | Close a drive |
| `app.unseed(key)` | Kill switch — remotely unseed (signed) |

### Quorum + verification API (v0.6.0)

| Method | Description |
|--------|-------------|
| `app.refreshCapabilityCache(urls)` | Fetch + cache capability docs from N relays |
| `app.selectQuorum(opts)` | Pick diverse / foundation / pinned / wide quorum |
| `app.queryQuorum(path, quorum)` | Hit all quorum relays in parallel |
| `app.queryQuorumWithComparison(path, quorum, opts)` | + auto-detect divergence |
| `app.isDriveQuarantined(driveKey)` | Check fork-detector quarantine state |
| `app.publishForkProof(proof, urls)` | Broadcast signed equivocation evidence |
| `app.pinRelay(url, pubkey)` / `unpinRelay()` | Out-of-band trust pinning |

### Capabilities + manifests API (v0.5.1)

| Method | Description |
|--------|-------------|
| `app.fetchCapabilities(url, opts)` | Get a relay's signed capability doc |
| `app.createSeedingManifest({relays, drives})` | Sign a seeding manifest |
| `app.publishSeedingManifest(url, manifest)` | Publish to a relay's cache |
| `app.fetchSeedingManifest(url, pubkey)` | Discover an author's preferred relays |

---

## For Operators

You have hardware — a VPS, a Mac Mini, a Raspberry Pi, an Umbrel. HiveRelay turns it into income.

### One-click install on Umbrel (v0.6.0, pending App Store review)

The consumer-facing Umbrel app is branded **Blindspark**. Install from the Umbrel App Store, walk through the 5-step setup wizard (~10 minutes), start earning Lightning sats.

→ See [`umbrel-app/README.md`](umbrel-app/README.md) and [`umbrel-app/SUBMISSION-CHECKLIST.md`](umbrel-app/SUBMISSION-CHECKLIST.md).

### Direct install (any platform)

```bash
npm install -g p2p-hiverelay
p2p-hiverelay setup        # Interactive wizard
# or:
p2p-hiverelay start --region NA --max-storage 50GB --holesail
```

### Live Management TUI

```bash
p2p-hiverelay tui          # Connect to running node
```

Full interactive control of services, resources, transports, accept-mode, federation, network settings — no restart needed.

### Operating Modes

| Mode | Description |
|------|-------------|
| **Standard** | Full relay + seeding + all services (256 conn, 100 Mbps) |
| **HomeHive** | Home/personal relay — 32 connections, 25 Mbps, LAN-priority, device pairing |
| **Seed Only** | App seeding only — relay disabled |
| **Relay Only** | Circuit relay only — seeding disabled |
| **Stealth** | Minimal footprint, designed for Tor-only operation |
| **Gateway** | HTTP gateway focus — 512 connections, 500 Mbps |

### Accept-Mode (v0.5.0)

Operators choose how inbound seed requests are handled:

- **`review`** (default) — operator approves every request
- **`allowlist`** — auto-accept publishers in the trusted list
- **`open`** — auto-accept everything signed (pair with payment-required)
- **`closed`** — relay-only mode, no inbound seed requests

### Federation (v0.5.0)

```bash
hiverelay federation follow https://relay.example.com
hiverelay federation mirror https://my-other-relay.example.com
```

Followed catalogs go through your accept-mode gate. Mirrored peers bypass the gate (use sparingly — only for "your own other node" or trusted partners).

### Earnings (rate card — v0.6.0 with LNbits integration)

| Service | Rate | Hardware Needed |
|---------|------|----------------|
| Storage | 10 sats/GB-month | Any |
| Egress | 20 sats/GB | Any |
| AI inference (M3) | 1-2 sats/1K tokens | 16GB+ RAM, GPU/Apple Silicon |

Earnings honest expectations: see [`docs/OPERATOR-INCENTIVES-Y1.md`](docs/OPERATOR-INCENTIVES-Y1.md).

---

## Security

Comprehensive security treatment in:

- **[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)** — three-category state model (authored / observed / derived), defense mechanisms, named attacks
- **[`docs/SECURITY-STRATEGY.md`](docs/SECURITY-STRATEGY.md)** — 32 attack vectors mapped to mitigations with status (🟢 in place / 🟡 in progress / 🟠 M2 / 🔴 open)
- **[`docs/OPERATOR-INCENTIVES-Y1.md`](docs/OPERATOR-INCENTIVES-Y1.md)** — answer to the "who pays operators in year 1 without a token" problem
- **[`docs/M2-ROADMAP.md`](docs/M2-ROADMAP.md)** — explicitly-scoped M2 deliverables (Operator Score, Sybil defense, sigstore signing, etc.)

### Security highlights (v0.6.0)

- ✅ **Capability docs cryptographically signed** by relay identity — tampering caught
- ✅ **LNbits admin key encrypted at rest** with AES-256-GCM, key from `$APP_SEED`
- ✅ **Diverse-quorum reads** with automatic divergence detection
- ✅ **Auto fork detection** during Hypercore replication; quarantines forked drives
- ✅ **Signed fork proofs** with observer attestation + freshness window
- ✅ **Per-endpoint rate limits** on sensitive paths (5/min on LNbits-key endpoint)
- ✅ **Audit trail** for `force:true` quarantine bypasses
- ✅ **Pubkey pinning** registry for out-of-band trust
- ⚠️ **M2 work remaining**: Operator Score, Sybil defense gates, reproducible builds, P2P-Auth v1 spec (see SECURITY-STRATEGY.md)

---

## Architecture

```
Developer App
    |
    +-- publish('./my-app')  -->  Hyperdrive (encrypted or plain)
    |                                |
    |                         Hyperswarm DHT
    |                    /     /     |     \     \
    |              JP    AU    AR    PT     LK     UAE     (foundation network)
    |              Relay Relay Relay Relay  Relay  Relay
    |                |     |     |    |      |       |
    |                +-----+- mutual federation -----+
    |                              |
    |                    Plus the wider operator network
    |                    (Umbrel home relays earning sats)
    |
    +-- client.queryQuorumWithComparison(...)  <--  diverse-quorum reads
    |                                                + auto fork detection
    |
    +-- client.unseed(key)     -->  Signed kill switch -> all relays
    |
    +-- HTTP gateway          -->  relay:9100/v1/hyper/{key}/path
```

- **Client SDK** — runs in Node.js or Pear/Bare runtime
- **Relay nodes** — Node.js (VPS, home hardware, Raspberry Pi, Umbrel)
- **Home relays** — Holesail transport for NAT traversal, no public IP needed
- **Foundation network** — 6 founder-owned properties across 6 continents (operator-of-last-resort)
- **Federation gossip** — fork proofs propagate within ~5 min of a federation poll cycle

---

## Quick Start

> **Requirements**: Node.js 20+

### For Developers

```bash
npm install p2p-hiverelay-client
```

```js
import { HiveRelayClient } from 'p2p-hiverelay-client'
const app = new HiveRelayClient('./my-storage')
await app.start()

const drive = await app.publish('./my-app')
await app.seed(drive.key)
```

### For Operators

```bash
npm install -g p2p-hiverelay
p2p-hiverelay setup
```

Or via Docker:

```bash
docker run -d --name hiverelay \
  -v hiverelay-data:/data \
  -v hiverelay-config:/config \
  -p 9100:9100 \
  ghcr.io/bigdestiny2/p2p-hiverelay:latest
```

Or via Umbrel App Store (v0.6.0): search "Blindspark" — coming after submission.

### Local Testnet

```bash
npx p2p-hiverelay testnet --nodes 5
```

---

## Test Coverage

**781 unit tests passing, 0 failures.** Significant coverage growth since v0.4.2 (~425 baseline) driven by recovering hidden tests + extensive new feature coverage.

| Suite | Approximate count |
|-------|---|
| Core relay logic | ~250 |
| Client SDK | ~120 |
| Security primitives (quorum, fork detection, signing) | ~110 |
| Federation + accept-mode | ~80 |
| Wizard + Umbrel app integration | ~40 |
| Identity + delegation | ~50 |
| Services layer | ~80 |
| Transports + payments | ~50 |

---

## Branches in this repo

| Branch | Purpose |
|---|---|
| `main` | Currently `v0.4.2` — what's deployed to live relays |
| `release/v0.5.0` | Architectural refactor + Pear runtime + federation |
| `release/v0.5.1` | Capability advertisement + error prefixes + author seeding manifests |
| `feat/umbrel-app` | v0.6.0 pipeline — Umbrel App Store package + comprehensive threat-model security work |

PRs:
- [#3 — v0.5.0](https://github.com/bigdestiny2/P2P-Hiverelay/pull/3)
- [#4 — v0.5.1](https://github.com/bigdestiny2/P2P-Hiverelay/pull/4)
- [#5 — v0.6.0 pipeline](https://github.com/bigdestiny2/P2P-Hiverelay/pull/5)

---

## Documentation

### Strategic & security
- **[MANIFESTO.md](docs/MANIFESTO.md)** — non-negotiable architectural values
- **[Hive_Engineering_Brief.md](docs/Hive_Engineering_Brief.md)** — architecture + business decisions
- **[THREAT-MODEL.md](docs/THREAT-MODEL.md)** — security thesis
- **[SECURITY-STRATEGY.md](docs/SECURITY-STRATEGY.md)** — attack-vector mitigation tracker
- **[OPERATOR-INCENTIVES-Y1.md](docs/OPERATOR-INCENTIVES-Y1.md)** — year-one economic model
- **[M2-ROADMAP.md](docs/M2-ROADMAP.md)** — what's next

### Operator & developer
- **[v0.5.1-CAPABILITIES.md](docs/v0.5.1-CAPABILITIES.md)** — capability doc + error prefixes + manifests spec
- **[PEAR-INTEGRATION.md](docs/PEAR-INTEGRATION.md)** — Pear/Bare usage guide
- **[CRYPTO-GUARANTEES.md](docs/CRYPTO-GUARANTEES.md)** — cryptographic primitives audit
- **[HOMEHIVE.md](docs/HOMEHIVE.md)** — private mode for home/family
- **[ECONOMICS.md](docs/ECONOMICS.md)** — economics design

### Umbrel
- **[umbrel-app/README.md](umbrel-app/README.md)** — operator-facing description
- **[umbrel-app/SUBMISSION-CHECKLIST.md](umbrel-app/SUBMISSION-CHECKLIST.md)** — pre-submission audit

---

## Links

- **GitHub**: [github.com/bigdestiny2/P2P-Hiverelay](https://github.com/bigdestiny2/P2P-Hiverelay)
- **npm (core)**: [p2p-hiverelay](https://www.npmjs.com/package/p2p-hiverelay)
- **npm (client)**: [p2p-hiverelay-client](https://www.npmjs.com/package/p2p-hiverelay-client)
- **npm (verifier, v0.6.0)**: [p2p-hiverelay-verifier](https://www.npmjs.com/package/p2p-hiverelay-verifier)
- **Docker image**: `ghcr.io/bigdestiny2/p2p-hiverelay:latest`
- **Live Dashboard**: `http://{relay}:9100/dashboard`
- **Catalog**: `http://{relay}:9100/catalog.json`

---

No blockchain. No token. No gatekeepers. Just infrastructure that keeps your apps online — paid in Lightning sats, owned by no one.
