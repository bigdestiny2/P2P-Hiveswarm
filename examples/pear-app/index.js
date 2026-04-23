/**
 * Minimal HiveRelay + Pear Example
 *
 * This shows the Bare-compatible way to use HiveRelay in a Pear app.
 * Key difference from Node.js: pass { swarm, store } instead of a path string.
 *
 * Run with: pear run .
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { HiveRelayClient } from 'p2p-hiverelay-client'

// In a real Pear app, use Pear.config.storage for persistent storage.
// For terminal testing, a local path works too.
const storagePath = typeof globalThis.Pear !== 'undefined'
  ? Pear.config.storage
  : './hiverelay-example-storage'

// IMPORTANT: let Corestore manage its own primaryKey.
//
// DO NOT do `new Corestore(path, { primaryKey: someIdentitySeed, unsafe: true })`.
// Tying Corestore's primaryKey to an external identity seed looks clean but
// is a data-loss hazard:
//   1. If the identity file gets corrupted or regenerated (unclean shutdown,
//      partial write, etc.), Corestore sees a new primaryKey != stored one
//      and throws "Another corestore is stored here".
//   2. In-process auto-recovery can't rm -rf the dir because rocksdb already
//      holds db/LOCK.
//   3. Manual recovery wipes the publisher keypair, orphaning every
//      HiveRelay-pinned drive (signed unseed requires the original keypair).
// Corestore persists its own primaryKey independently. Drives survive
// identity regeneration. See docs/IDENTITY-AND-STORAGE.md for the full
// reasoning and a recovery-safe pattern.
const store = new Corestore(storagePath)
const swarm = new Hyperswarm()

const relay = new HiveRelayClient({ swarm, store })

relay.on('relay-connected', ({ pubkey }) => {
  console.log('Connected to relay:', pubkey.slice(0, 12) + '...')
})

await relay.start()
console.log('HiveRelay client started')

// Publish some content
const drive = await relay.publish([
  { path: '/index.html', content: '<h1>Hello from Pear!</h1><p>This app is always online via HiveRelay.</p>' },
  { path: '/manifest.json', content: JSON.stringify({ name: 'pear-example', version: '1.0.0' }) }
])

console.log('Published! Share this key:')
console.log('  ' + drive.key.toString('hex'))

// Check which relays picked it up
const relays = relay.getRelays()
console.log(`Connected to ${relays.length} relay(s)`)

// Seed the content for persistence
const appKeyHex = drive.key.toString('hex')
await relay.seed(appKeyHex, { replicationFactor: 3 })
console.log('Seed request sent — relays will replicate your content')

// Show available apps on the network. Each row is one (app, relay) pair —
// per-relay catalogs are local to each operator (no global merged view).
const apps = relay.getAvailableApps()
if (apps.length > 0) {
  console.log(`\n${apps.length} app row(s) across connected relays:`)
  for (const app of apps) {
    const id = app.appId || app.appKey.slice(0, 12) + '...'
    console.log(`  - ${id} (from relay ${app.source.relayPubkey.slice(0, 12)})`)
  }
}

// Keep running
console.log('\nApp is running. Press Ctrl+C to stop.')
console.log('Your content stays available on relay nodes even after you quit.')
