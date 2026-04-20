> [!WARNING]
> **Doc may be partially out of date.** This file was written before the Compute removal, Core/Services split, and Catalog auto-sync removal. See [REFACTOR-NOTES.md](REFACTOR-NOTES.md) for current architecture.

# HiveRelay + PearBrowser — App Store Infrastructure

HiveRelay is the backbone infrastructure that powers PearBrowser's decentralized App Store. Without it, P2P apps on mobile are slow, unreliable, and undiscoverable. With it, apps load instantly, stay available 24/7, and users never need to touch a Hyperdrive key.

## Why HiveRelay Is Essential

### Problem 1: Apps need to be available 24/7

A developer publishes a POS app from their laptop. They close the laptop and go to sleep. A user in another timezone opens PearBrowser and wants to install the POS app.

**Without HiveRelay:** App unavailable. No peers online serving that Hyperdrive.

**With HiveRelay:** App loads instantly. Relay seeded the drive and serves it via HTTP gateway.

### Problem 2: Mobile P2P is slow for first load

Finding peers on the DHT takes 5-15 seconds. Downloading a 1.3MB app bundle over P2P takes more time on top of that. Users expect pages to load in under 2 seconds.

**Without HiveRelay:** User stares at "Connecting..." for 15+ seconds.

**With HiveRelay:** Relay serves the app via HTTP in under 2 seconds.

### Problem 3: The catalog needs a home

The App Store catalog (`/catalog.json`) lists all available apps with names, descriptions, and categories. Someone needs to host it reliably so users can discover apps.

**Without HiveRelay:** Every user needs to manually enter 64-character Hyperdrive keys. No discovery. No browsing.

**With HiveRelay:** Relay auto-builds the catalog from seeded drives that contain a `manifest.json`. Users just open the App Store tab and browse.

### Problem 4: Data availability for sync

POS transactions and inventory sync via Autobase across multiple devices. If all devices are offline, new devices joining the sync group can't catch up on missed data.

**Without HiveRelay:** Data only syncs when peers happen to be online at the same time.

**With HiveRelay:** Relay seeds the Autobase cores, ensuring data is always available for new peers to replicate from.

## The Architecture

```
HiveRelay Node
├── Hyperswarm (P2P networking)         ← peers connect here
├── Seeder (replicates Hyperdrives)     ← stores app files permanently
├── HTTP Gateway (/v1/hyper/KEY/*)      ← serves apps to PearBrowser instantly
├── Catalog (/catalog.json)             ← auto-built app directory
├── Circuit Relay (NAT traversal)       ← helps mobile peers behind firewalls
├── Reputation + Proof-of-Relay         ← trust and verification
└── HiveCompute (future)               ← AI inference for P2P apps

PearBrowser (iOS)
├── App Store → loads /catalog.json from relay
├── App Launch → fetches from /v1/hyper/KEY/ (instant HTTP)
├── P2P sync → Autobase over Hyperswarm (relay provides availability)
├── Site Builder → publishes to relay for 24/7 seeding
└── Browser → browses hyper:// via hybrid fetch (relay + P2P)
```

HiveRelay is to PearBrowser what CDN + App Store infrastructure + sync servers are to a traditional mobile app — except it's decentralized. Anyone can run a relay.

## How It Works End-to-End

### Developer Publishes an App

```
Developer                          HiveRelay                        PearBrowser User
─────────                          ─────────                        ────────────────

1. Build app (HTML/JS/CSS)
   + manifest.json

2. Publish as Hyperdrive
   → node publish-app.js ./dist
   → Key: abc123...

3. Seed on relay                 → Relay joins swarm for abc123
   POST /seed {"appKey":"abc123"}  → Replicates Hyperdrive files
                                   → Reads manifest.json
                                   → Adds to /catalog.json

                                                                    4. Opens App Store tab
                                                                       → Fetches /catalog.json
                                                                       → Sees "My App" listed

                                                                    5. Taps "Get" → "Open"
                                                                       → Loads from /v1/hyper/abc123/
                                                                       → Renders instantly (HTTP)

                                                                    6. App data syncs via Autobase
                                                                       → P2P through Hyperswarm
                                                                       → Relay ensures availability
```

### User Browses hyper:// Content

PearBrowser uses a hybrid fetch architecture — two paths race simultaneously:

```
Phone navigates to hyper://KEY/path
  │
  ├── Fast path: HTTP GET relay:9100/v1/hyper/KEY/path
  │   └── If relay has it seeded → response in 1-2 seconds
  │
  └── P2P path: Hyperswarm DHT → find peers → download
      └── Direct peer connection → response in 5-15 seconds

Whichever responds first wins. Both paths run concurrently.
```

After first load, content is cached locally on the phone. Subsequent visits are instant.

## Relay API Endpoints for PearBrowser

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/catalog.json` | GET | App catalog — auto-built from seeded drives with manifest.json |
| `/v1/hyper/:key/*path` | GET | Serve Hyperdrive content over HTTP (gateway) |
| `/api/gateway` | GET | Gateway stats (cached drives, requests, bytes served) |
| `/seed` | POST | Seed a new Hyperdrive (accepts `{"appKey": "hex"}`) |
| `/health` | GET | Relay health check |
| `/status` | GET | Full relay status (connections, seeded apps, bandwidth) |

### App Manifest Format

Every app Hyperdrive must contain `/manifest.json` for the catalog to index it:

```json
{
  "name": "Pear POS",
  "version": "1.0.0",
  "description": "P2P point-of-sale with receipt scanning & payments",
  "author": "developer-name",
  "entry": "/index.html",
  "categories": ["business"],
  "permissions": ["camera"]
}
```

### HTML Path Rewriting

The gateway automatically rewrites absolute asset paths in HTML responses so Vite-built apps work correctly:

```
Original:  <script src="/assets/index-abc123.js">
Rewritten: <script src="./assets/index-abc123.js">
```

This ensures relative resolution through the gateway path (`/v1/hyper/KEY/assets/...`).

## What the Relay Provides vs. What's P2P

| Function | Relay (HTTP) | P2P (Hyperswarm) |
|----------|-------------|------------------|
| App frontend delivery | Primary (instant) | Fallback (slow first load) |
| App catalog / discovery | Primary | N/A |
| Data sync (Autobase) | Availability backup | Primary (real-time) |
| NAT traversal | Circuit relay | UDP hole-punching |
| Content availability | 24/7 (always-on) | Only when peers online |
| Site publishing | Seeds for availability | Direct peer serving |

## Running a Relay for PearBrowser

Any HiveRelay node with the gateway module enabled automatically supports PearBrowser:

```bash
# Start a relay node
node cli/index.js start --port 9100

# The relay automatically:
# - Joins the DHT for peer discovery
# - Serves /catalog.json from seeded drives
# - Serves /v1/hyper/KEY/* for seeded content
# - Provides circuit relay for NAT traversal

# Seed an app so it appears in the catalog
curl -X POST http://localhost:9100/seed \
  -H 'Content-Type: application/json' \
  -d '{"appKey": "abc123..."}'

# Verify the catalog
curl http://localhost:9100/catalog.json
```

## Multiple Relays

PearBrowser can connect to multiple relays. Each relay maintains its own catalog based on what it seeds. Users can add relay URLs in Settings.

Relay operators choose what to seed — they can run:
- **General catalogs** — seed everything, like a public app store
- **Curated catalogs** — only seed vetted apps
- **Private catalogs** — company-internal apps
- **Regional catalogs** — apps relevant to a specific geography

The decentralization comes from the fact that anyone can run a relay, and PearBrowser aggregates across multiple catalogs.

## Future: HiveCompute Integration

HiveRelay nodes that also run HiveCompute can provide AI inference to P2P apps through the `window.pear.compute` bridge:

```javascript
// Inside a P2P app running in PearBrowser
const stream = window.pear.compute.inference({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Summarize this receipt' }]
})
for await (const chunk of stream) {
  console.log(chunk.text)
}
```

The relay discovers HiveCompute nodes on the DHT and routes inference requests to the nearest available GPU.

## Links

- **[PearBrowser](https://github.com/bigdestiny2/PearBrowser)** — The iOS P2P app platform
- **[HiveRelay](https://github.com/bigdestiny2/p2p-hiverelay)** — The relay backbone
- **[Holepunch](https://holepunch.to)** — The underlying P2P stack