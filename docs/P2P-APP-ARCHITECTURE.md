# Building P2P Apps — Architecture Guide

A complete guide to building, publishing, and running peer-to-peer applications on the Holepunch stack with HiveRelay and PearBrowser.

## What Is a P2P App?

A P2P app is a web application (HTML/CSS/JS) that runs on your device with no cloud server. Instead of fetching data from an API endpoint, your device connects directly to other devices over encrypted peer-to-peer connections. Data lives on the devices that use it — not in someone else's data center.

```
Traditional App                           P2P App
─────────────                             ───────
Phone → Internet → Cloud Server → DB      Phone ←→ Phone
                                          Phone ←→ Relay ←→ Phone
                                          Phone ←→ DHT ←→ Phone
```

The "server" in a P2P app is every device running the app. When you create a product in a POS system, that data is written locally AND replicated to every other device in your sync group — directly, without a middleman.

## The Stack

Five layers, each solving a specific problem:

```
┌─────────────────────────────────────────┐
│  YOUR APP (HTML/CSS/JS)                 │  ← What you build
│  Runs in PearBrowser's WebView          │
├─────────────────────────────────────────┤
│  window.pear Bridge                     │  ← P2P APIs for your app
│  Sync, Identity, Storage                │
├─────────────────────────────────────────┤
│  Autobase + Hyperbee                    │  ← Multi-device data sync
│  Append-only logs → materialized views  │
├─────────────────────────────────────────┤
│  Hyperswarm + HyperDHT                  │  ← Peer discovery & connection
│  UDP hole-punching, Noise encryption    │
├─────────────────────────────────────────┤
│  HiveRelay                              │  ← Always-on infrastructure
│  HTTP gateway, seeding, catalog, relay  │
└─────────────────────────────────────────┘
```

### Layer 1: Your App

A standard web app. HTML for structure, CSS for styling, JavaScript for logic. No special framework required. Works with React, Vue, Svelte, vanilla JS — anything that runs in a browser.

The only difference from a normal web app: instead of `fetch('/api/products')`, you call `window.pear.sync.list('my-app', 'products!')`.

### Layer 2: window.pear Bridge

PearBrowser injects a JavaScript bridge into every WebView. Your app calls these APIs to access P2P features:

```javascript
// Create a sync group (like creating a database)
await window.pear.sync.create('my-app')

// Write data
await window.pear.sync.append('my-app', {
  type: 'product:create',
  data: { id: 'prod_1', name: 'Coffee', price_cents: 450 }
})

// Read data
const products = await window.pear.sync.list('my-app', 'products!')
// → [{ key: 'products!prod_1', value: { id: 'prod_1', name: 'Coffee', ... } }]

// Get device identity
const { publicKey } = await window.pear.identity.getPublicKey()
```

The bridge routes these calls through React Native → IPC → Bare worklet → Autobase. Your app never touches the P2P layer directly.

### Layer 3: Autobase + Hyperbee

**Autobase** is a multi-writer database built on Hypercore. Each device has its own append-only log. Autobase merges all logs in causal order and feeds them through an `apply` function that builds a deterministic view.

```
Device A writes:  { type: 'product:create', data: { id: '1', name: 'Coffee' } }
Device B writes:  { type: 'product:create', data: { id: '2', name: 'Tea' } }

Autobase merges both logs → apply function runs → Hyperbee view:
  products!1 → { id: '1', name: 'Coffee' }
  products!2 → { id: '2', name: 'Tea' }
```

Every device running the same Autobase group sees the same view. Conflicts are resolved deterministically (last-write-wins by default). The view is a **Hyperbee** — a B-tree built on Hypercore, supporting key-value lookups and range queries.

**Key concept:** You don't query a server. You query your local Hyperbee view, which is always up-to-date because Autobase continuously replicates and applies operations from all peers.

### Layer 4: Hyperswarm + HyperDHT

**HyperDHT** is a distributed hash table — a global directory where peers announce themselves and find each other. No central server coordinates this. Thousands of DHT nodes collectively maintain the routing table.

**Hyperswarm** sits on top of HyperDHT and handles the actual connections:

1. Your device joins a "topic" (a 32-byte hash derived from your sync group key)
2. HyperDHT finds other devices on the same topic
3. Both devices attempt UDP hole-punching simultaneously
4. If hole-punching succeeds (~95% of the time), a direct encrypted connection is established
5. If it fails (symmetric NAT), a relay node forwards the traffic

All connections use the **Noise protocol** for encryption. Relay nodes can forward bytes but can't read them.

```
Your Phone                    DHT                        Other Device
──────────                    ───                        ────────────
join(topic)  ──────────────→  "who else is on topic X?"
                              ←──── "Device B is at IP:PORT"
             ←─── UDP hole-punch ───→
             ←═══ Encrypted stream ══→  (direct connection!)

If hole-punch fails:
             ←── via Relay Node ──→    (relayed, still encrypted)
```

### Layer 5: HiveRelay

HiveRelay nodes are the "always-on" infrastructure of the P2P network:

- **HTTP Gateway** — serves app frontends instantly (no P2P wait for first load)
- **Seeding** — replicates and stores Hyperdrives so content is always available
- **Catalog** — auto-builds an app directory from seeded drives
- **Circuit Relay** — forwards encrypted bytes for peers that can't hole-punch
- **Availability** — keeps Autobase data accessible 24/7, even when all user devices are offline

Anyone can run a relay. The more relays, the more resilient the network.

## How Data Flows

### Writing Data

```
User taps "Add Product"
  → App calls window.pear.sync.append('pos', { type: 'product:create', data: {...} })
  → Bridge posts message to React Native
  → RN forwards to Bare worklet via RPC
  → Worklet appends to local Autobase writer (Hypercore)
  → Apply function runs → Hyperbee view updated
  → Hyperswarm replicates the new entry to connected peers
  → Other devices' apply functions run → their views update
  → Other devices' UIs react to the new data
```

### Reading Data

```
App loads product list
  → App calls window.pear.sync.list('pos', 'products!')
  → Bridge → RN → RPC → Worklet
  → Worklet queries local Hyperbee view (instant, no network)
  → Returns array of products
  → App renders the list
```

Reading is always local. The Hyperbee view is on your device. Network latency is zero for reads.

### Syncing Between Devices

```
Device A (phone)                         Device B (tablet)
────────────────                         ─────────────────
Autobase writer: [op1, op2, op3]         Autobase writer: [op4, op5]
                    ↓ replicate via Hyperswarm ↓
Autobase merges: [op1, op2, op3, op4, op5]
Apply → Hyperbee: products!1, products!2, products!3
                    (same view on both devices)
```

Sync is automatic. When devices connect, Autobase exchanges new operations and both sides rebuild the view. The apply function guarantees the same result regardless of the order operations arrive.

## Building an App

### 1. Create Your App

```
my-app/
├── index.html          ← Entry point
├── manifest.json       ← App metadata for the catalog
├── style.css
└── app.js
```

**index.html:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My P2P App</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div id="app"></div>
  <script src="app.js"></script>
</body>
</html>
```

**manifest.json:**
```json
{
  "name": "My App",
  "version": "1.0.0",
  "description": "What my app does",
  "author": "your-name",
  "entry": "/index.html",
  "categories": ["utilities"],
  "permissions": []
}
```

**app.js:**
```javascript
// Initialize sync group
async function init() {
  // Create or join a sync group
  const saved = localStorage.getItem('my-app-invite')
  if (saved) {
    await window.pear.sync.join('my-app', saved)
  } else {
    const result = await window.pear.sync.create('my-app')
    localStorage.setItem('my-app-invite', result.inviteKey)
  }

  // Load existing data
  const items = await window.pear.sync.list('my-app', 'items!')
  renderItems(items.map(i => i.value))
}

// Add an item
async function addItem(name) {
  const id = 'item_' + Date.now()
  await window.pear.sync.append('my-app', {
    type: 'item:create',
    data: { id, name, created: new Date().toISOString() }
  })
  // Refresh the list
  const items = await window.pear.sync.list('my-app', 'items!')
  renderItems(items.map(i => i.value))
}

function renderItems(items) {
  document.getElementById('app').innerHTML = items
    .map(i => `<div>${i.name}</div>`)
    .join('')
}

init()
```

### 2. Test Locally

Open `index.html` in a browser. The `window.pear` API won't exist, so add a fallback:

```javascript
if (!window.pear) {
  // Mock for local development
  const store = {}
  window.pear = {
    sync: {
      create: async () => ({ inviteKey: 'local-test' }),
      join: async () => ({ inviteKey: 'local-test' }),
      append: async (app, op) => {
        const key = op.type.replace(':', '!') + '!' + (op.data.id || Date.now())
        store[key] = op.data
      },
      list: async (app, prefix) => {
        return Object.entries(store)
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }))
      }
    }
  }
}
```

### 3. Publish to the Network

```bash
# Install the publish tool
npm install -g pearbrowser-tools  # or use directly from PearBrowser repo

# Publish your app directory as a Hyperdrive
node publish-app.js ./my-app --name "My App" --description "What it does"

# Output:
#   Name:  My App
#   Key:   a1b2c3d4e5f6...
#   URL:   hyper://a1b2c3d4e5f6...
#
#   Keep this process running to serve the app.
```

This creates a Hyperdrive containing your app files and announces it on the DHT.

### 4. Seed on a HiveRelay

For 24/7 availability (so users can install your app even when your machine is off):

```bash
curl -X POST http://your-relay:9100/seed \
  -H 'Content-Type: application/json' \
  -d '{"appKey": "a1b2c3d4e5f6..."}'
```

The relay replicates your Hyperdrive and:
- Serves it via HTTP gateway (`/v1/hyper/KEY/index.html`)
- Adds it to its catalog (`/catalog.json`)
- Keeps it available 24/7

### 5. Users Find Your App

PearBrowser users who have your relay URL in their App Store will see your app:

1. Open PearBrowser → Apps tab
2. Your relay's catalog loads
3. "My App" appears with name, description from manifest.json
4. Tap "Get" → tap "Open"
5. App loads instantly from the relay's HTTP gateway

No Hyperdrive keys. No technical knowledge. Just an app store.

## Updating Your App

Update files in your directory and re-publish:

```bash
# Edit your app files
vim my-app/app.js

# Re-publish (same process, new content)
node publish-app.js ./my-app --name "My App"
```

The Hyperdrive is versioned — the key stays the same, only the content updates. The relay automatically replicates the new version. Users get the update next time they open the app.

## Multi-Device Sync

To let multiple devices share data:

**Device 1 (creates the sync group):**
```javascript
const result = await window.pear.sync.create('my-app')
const inviteKey = result.inviteKey
// Share this key with Device 2 (QR code, message, etc.)
```

**Device 2 (joins the sync group):**
```javascript
await window.pear.sync.join('my-app', inviteKey)
// Now both devices share the same Autobase
// Writes on either device appear on both
```

The invite key is a Hypercore public key. It's the identity of the sync group. Anyone with the key can join and sync data.

## The Apply Function

When you write data via `window.pear.sync.append()`, the operation goes through an **apply function** that builds the Hyperbee view. PearBrowser includes a default apply function that maps operations to keys:

```
{ type: 'product:create', data: { id: '1', name: 'Coffee' } }
→ Hyperbee key: products!1
→ Hyperbee value: { id: '1', name: 'Coffee' }

{ type: 'product:update', data: { id: '1', updates: { price: 500 } } }
→ Reads existing products!1
→ Merges updates
→ Writes products!1 = { id: '1', name: 'Coffee', price: 500 }

{ type: 'product:delete', data: { id: '1' } }
→ Marks products!1 as { ..., active: false }
```

The key convention is: `{entity_type}!{id}`. Range queries with prefix `products!` return all products. This is the same pattern used by Pear POS.

## Security Model

| Layer | Protection |
|-------|-----------|
| **Transport** | All peer connections encrypted with Noise protocol. Relay nodes can't read data. |
| **Identity** | Each device has an Ed25519 keypair. Operations are signed. |
| **Sync groups** | Only devices with the invite key can join. The key IS the access control. |
| **App isolation** | Each app's Autobase is separate. Apps can't access each other's data. |
| **Relay trust** | Relays serve content but can't modify it (Hypercore integrity verification). |

## Comparison with Traditional Architecture

| Aspect | Traditional | P2P with HiveRelay |
|--------|-------------|---------------------|
| **Server** | Required (AWS, Heroku, etc.) | None. Relay is optional infrastructure. |
| **Database** | PostgreSQL, MongoDB on server | Autobase/Hyperbee on every device |
| **API** | REST/GraphQL over HTTPS | window.pear bridge (local calls) |
| **Hosting cost** | $20-200/month | $0 (relay is community infrastructure) |
| **Data ownership** | Provider owns your data | You own your data (on your devices) |
| **Offline support** | Limited (service workers) | Full (all reads are local) |
| **Multi-device sync** | Through server | Direct peer-to-peer |
| **Scalability** | Pay for more servers | Each user brings their own compute |
| **Censorship** | Server can be shut down | No single point of failure |
| **Privacy** | Provider can read your data | End-to-end encrypted |

## Example Apps

### Pear POS (Point of Sale)
- Full POS system with product catalog, barcode scanning, transactions
- Multi-terminal sync via Autobase
- Receipt scanning with on-device AI
- Payment processing (Stripe, Lightning)
- **Live in PearBrowser App Store**

### Calculator
- Simple calculator running entirely P2P
- No data sync needed — pure frontend
- Demonstrates zero-infrastructure app delivery

### Notes
- Note-taking app with local storage
- Data persists via localStorage in the WebView
- Future: sync notes across devices via Autobase

## Links

- **[PearBrowser](https://github.com/bigdestiny2/PearBrowser)** — iOS P2P app platform
- **[HiveRelay](https://github.com/bigdestiny2/P2P-Hiveswarm)** — Relay infrastructure
- **[Holepunch](https://holepunch.to)** — The P2P stack
- **[Bare Runtime](https://bare.pears.com)** — JS runtime for mobile
- **[Hyperswarm](https://github.com/holepunchto/hyperswarm)** — Peer discovery
- **[Autobase](https://github.com/holepunchto/autobase)** — Multi-writer database
