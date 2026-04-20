> [!WARNING]
> **Doc may be partially out of date.** This file was written before the Compute removal, Core/Services split, and Catalog auto-sync removal. See [REFACTOR-NOTES.md](REFACTOR-NOTES.md) for current architecture.

# HiveRelay for Pear Developers

HiveRelay gives your Pear app always-on content persistence, NAT traversal relay, and service infrastructure -- without running your own servers.

## Quick Start (Pear App)

```js
import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay/client'

// Use Pear's storage -- NOT a filesystem path
const store = new Corestore(Pear.config.storage)
const swarm = new Hyperswarm()

const relay = new HiveRelayClient({ swarm, store })
await relay.start()
```

That's it. The client discovers public HiveRelay nodes via the DHT and connects automatically.

## Publish Your App

```js
// Publish files to a Hyperdrive and seed across relay nodes
const drive = await relay.publish([
  { path: '/index.html', content: '<h1>My Pear App</h1>' },
  { path: '/app.js', content: 'console.log("running")' }
])

console.log('App key:', drive.key.toString('hex'))
```

Your app is now replicated across relay nodes. Users can access it even when your device is offline.

## Open and Read Content

```js
// On another device -- open content by key
const drive = await relay.open(appKey)
const html = await relay.get(appKey, '/index.html')
```

## Seed an Existing Pear App

If you've already staged a Pear app with `pear stage`, seed it on the relay network:

```js
// appKey is the hex key from `pear stage` or `pear info`
await relay.seed(appKey, {
  replicationFactor: 3,   // How many relays should host it
  maxStorageBytes: 50e6   // 50 MB cap
})
```

## Why Pear Apps Need Relay Infrastructure

| Problem | How HiveRelay Solves It |
|---------|------------------------|
| **Peer goes offline, content disappears** | Relay nodes persist and serve your Hyperdrives 24/7 |
| **NAT traversal fails (~5% of connections)** | Circuit relay bridges peers behind symmetric NATs |
| **Mobile networks block UDP** | WebSocket transport provides fallback connectivity |
| **No one seeds your app overnight** | Relay operators run always-on nodes for the network |
| **Bootstrap nodes go down** | Bootstrap cache ensures your app reconnects |

## Architecture: What Runs Where

```
Your Pear App (Bare runtime)          Relay Node (Node.js on VPS)
--------------------------------      --------------------------------
HiveRelayClient (client SDK)    <-->  RelayNode (full relay)
  - publish / open / get                - seeds your Hyperdrives
  - seed requests                       - circuit relay for NAT traversal
  - service RPC                         - HTTP API + dashboard
  - lightweight, no server deps         - requires Node.js (http, worker_threads)
```

The client SDK runs in Bare/Pear. The relay node runs on Node.js (VPS operators). You don't need to run a relay -- you just connect to the network.

## Storage: Pear vs Node.js

The key difference for Pear apps is storage. Don't pass a string path:

```js
// Node.js -- filesystem path
const relay = new HiveRelayClient('./my-storage')

// Pear -- use Pear's storage API
const store = new Corestore(Pear.config.storage)
const relay = new HiveRelayClient({ store })
```

If you want to bring your own Hyperswarm (recommended for Pear apps that already have one):

```js
const relay = new HiveRelayClient({ swarm: myExistingSwarm, store })
```

## Service RPC

Call services on relay nodes from your Pear app:

```js
// Check relay identity
const info = await relay.callService('identity', 'whoami')

// Verify a signature
const result = await relay.callService('identity', 'verify', {
  message: 'hello',
  signature: sigHex,
  pubkey: pubkeyHex
})

// Look up a developer
const dev = await relay.callService('identity', 'developer', {
  key: developerPubkeyHex
})
```

## Available Services

| Service | Methods | Description |
|---------|---------|-------------|
| **identity** | whoami, verify, sign, resolve, peers, developer | Keypair identity and developer resolution |
| **storage** | drive-create, drive-read, drive-write, core-create, core-append | Hyperdrive and Hypercore operations |
| **compute** | submit, status, result, cancel | Task execution (sandboxed) |
| **schema** | register, get, validate, list | Schema registry for data validation |
| **sla** | create, status, terminate | Service level agreements |
| **arbitration** | submit, vote, get, list | Dispute resolution |

## Developer Identity (LNURL-Auth)

Link your Lightning wallet to your developer identity:

1. Your Pear app calls the relay's LNURL-auth endpoint
2. You scan a QR code with your Lightning wallet
3. Your wallet signs a challenge, proving you own a secp256k1 key
4. The relay creates an attestation linking your Ed25519 app key to your developer identity
5. Your Nostr profile (if you have one) automatically resolves as your developer profile

No passwords, no accounts, no email -- just your Lightning key.

## Configuration

```js
const relay = new HiveRelayClient({
  // Required for Pear (one of these)
  store: myCorestore,              // Corestore instance
  // OR
  swarm: mySwarm,                  // Existing Hyperswarm

  // Optional
  keyPair: myKeyPair,              // Ed25519 keypair for signing
  maxRelays: 5,                    // Max relay connections
  seedTimeout: 15000,              // Seed request timeout (ms)
  bootstrapCache: true             // Cache DHT bootstrap peers
})
```

## FAQ

**Can I run a relay node inside a Pear app?**
No. The relay node requires Node.js-specific APIs (http server, worker threads). Relay operators run standard Node.js on VPS servers. Your Pear app uses the lightweight client SDK.

**Do I need to pay for relay services?**
Relay operators can offer free tiers. The credit system supports Lightning payments for premium capacity, but many operators provide free seeding for the ecosystem.

**What if all relays go down?**
Your Pear app still works peer-to-peer. Relays enhance availability but aren't required for basic P2P functionality. The client automatically reconnects when relays come back.

**How do I find relays?**
The client discovers relays automatically via the HyperDHT. No configuration needed. You can also connect to specific relays by key if preferred.