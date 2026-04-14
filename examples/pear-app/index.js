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
import { HiveRelayClient } from 'p2p-hiverelay/client'

// In a real Pear app, use Pear.config.storage for persistent storage.
// For terminal testing, a local path works too.
const storagePath = typeof globalThis.Pear !== 'undefined'
  ? Pear.config.storage
  : './hiverelay-example-storage'

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

// Show available apps on the network
const apps = relay.getAvailableApps()
if (apps.length > 0) {
  console.log(`\n${apps.length} app(s) available on the network:`)
  for (const app of apps) {
    console.log(`  - ${app.appId || app.appKey.slice(0, 12) + '...'} (${app.relays.length} relay(s))`)
  }
}

// Keep running
console.log('\nApp is running. Press Ctrl+C to stop.')
console.log('Your content stays available on relay nodes even after you quit.')
