# PearBrowser ↔ HiveRelay integration brief

> Companion to [PEARBROWSER-INTEGRATION.md](PEARBROWSER-INTEGRATION.md). The
> older doc described the pre-refactor merged-catalog model. This brief
> covers the per-relay catalog model with explicit subscriptions, plus the
> new DHT-relay-WS browser surface.

## What changed for the browser

Before:
- One global merged catalog. PearBrowser's App Store assumed a unified view.
- Auto-sync between relays propagated apps without operator consent.
- No way for browsers to participate in HyperDHT lookups (no UDP).

After:
- **Each relay has a local catalog.** Operators manually approve apps.
  PearBrowser must subscribe to specific relay catalogs, not merge them.
- **Federation is per-subscription.** A relay can advertise that it follows /
  mirrors / republishes from other relays — that's metadata for the UI to
  show provenance, not a discovery mechanism.
- **Browsers can run a real HyperDHT** by tunneling through any HiveRelay
  node that exposes the new `dhtRelayWs` transport.

## What PearBrowser needs to add

### 1. Subscribed-catalog list

A user-managed list of relay URLs the browser should query. Default starter
list ships with PearBrowser; users add/remove freely.

```ts
interface RelaySubscription {
  url: string                  // e.g. "https://relay-a.example"
  pubkey?: string              // optional, for verification
  trustLevel: 'follow' | 'mirror'  // mirror means show "trusted partner" badge
  addedAt: number
}
```

Persist this in PearBrowser settings. Suggested keys:
`pearbrowser.subscribedRelays`, `pearbrowser.starterRelays` (read-only seed list).

### 2. App Store discovery: query each catalog separately

Replace any "global catalog" assumption with parallel fetches:

```js
async function getAvailableApps (subscriptions) {
  const results = await Promise.allSettled(
    subscriptions.map(sub => fetch(`${sub.url}/catalog.json`).then(r => r.json()))
  )
  // Each result has the new shape (post-refactor):
  // { apps, drives, federation: { followed, mirrored, republished }, acceptMode, ... }
  // Tag every entry with its source relay so the UI can render badges.
  const rows = []
  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue
    const sub = subscriptions[i]
    const data = results[i].value
    for (const app of (data.apps || [])) {
      rows.push({
        ...app,
        source: { url: sub.url, pubkey: data.relayKey, trustLevel: sub.trustLevel }
      })
    }
  }
  return rows
}
```

The HiveRelay client SDK (`p2p-hiverelay-client`) already returns this
shape via `getAvailableApps()` for the embedded P2P client path. PearBrowser
can either use the SDK or hit `/catalog.json` directly via HTTP.

### 3. Source badges in the UI

Every app row in the App Store gets a small "from {relay}" badge. On hover,
expand to a tooltip showing the federation context:

> **kept-relay.example** (you follow this)
> Last updated 2m ago · 1,247 apps in catalog · acceptMode: review

If the same app appears on N relays, show all N badges (or "+N more").
Don't dedupe silently — operators chose to carry the app, and that signal
matters to the user.

If the relay's catalog includes a `federation.republished` entry for this
app, show a "republished from {sourceUrl}" sub-badge. That's how curated
channels show up.

### 4. Quick-add catalog flow

When users encounter an unfamiliar HiveRelay URL (clicking a shared app
link, scanning a QR code, etc.), PearBrowser should offer a one-tap
"Subscribe to this relay" action that adds the URL to their subscriptions.
Spec says: don't auto-trust; require an explicit click.

### 5. DHT-relay-WS for direct P2P

For features that need real-time P2P (live presence, ephemeral chat, rooms
that don't fit the seeded-app model), PearBrowser can run a real HyperDHT
in the browser by tunneling through a HiveRelay node:

```js
import DHT from '@hyperswarm/dht-relay'
import Stream from '@hyperswarm/dht-relay/ws'

// Pick any subscribed relay that advertises dhtRelayWs
const socket = new WebSocket(`wss://relay-a.example:8766`)
const dht = new DHT(new Stream(true, socket))

// From here, dht.lookup(), dht.announce(), dht.connect() etc. all work.
```

Operators opt in to this transport via `config.transports.dhtRelayWs`. By
default it's off — PearBrowser shouldn't assume every subscribed relay
exposes it. The relay's `/status` endpoint can advertise capability:

```js
const caps = await fetch(`${relayUrl}/status`).then(r => r.json())
if (caps.transports?.dhtRelayWs?.enabled) {
  // OK to attempt DHT-over-WS
}
```

(The relay's getStats already returns transport info; expose it on /status
if not already there — small follow-up.)

## What PearBrowser does NOT need to do

- **Don't try to merge catalogs.** That's the old model. Per-relay rows
  with source badges is the correct UX shape.
- **Don't auto-discover relays from peers.** Subscriptions are user-driven.
  Even when a subscribed relay advertises `federation.followed: [...]`,
  treat that as informational, not a hint to subscribe.
- **Don't show republished apps as if they originated locally.** Always
  attribute back to the source.

## Migration path for existing PearBrowser users

If PearBrowser ships an upgrade after the HiveRelay refactor lands:

1. On first run after upgrade, take whatever existing relay URL list the user
   had and convert to `subscribedRelays` with `trustLevel: 'follow'`.
2. Show a one-time notice: "App Store now shows where each app came from.
   Manage your subscriptions in Settings."
3. Default to the same relay list as before — no surprises in what's
   visible. The badges are net-additive UI.

## Backend touchpoints summary

| Endpoint | Purpose |
|---|---|
| `GET {relayUrl}/catalog.json` | Per-relay app list with `acceptMode` and `federation` field |
| `GET {relayUrl}/status` | Capability discovery (transports enabled, services hosted) |
| `wss://{relayUrl}:8766` (when `dhtRelayWs` enabled) | DHT-over-WS for browser P2P |
| `wss://{relayUrl}:8765` (when `wsTransport` enabled) | Hypercore replication over WS — for direct browser↔relay seeding |

All four endpoints are read-only / no-auth from the browser's perspective.
Operator management endpoints (`/api/manage/*`) are out of scope for
PearBrowser — they're for the operator's own dashboard.
