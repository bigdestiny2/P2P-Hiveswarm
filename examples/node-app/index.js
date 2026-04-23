/**
 * Minimal HiveRelay + Node.js Example
 *
 * Publish a directory of files to the relay network.
 * Your content stays online even after you close this process.
 *
 * Run with: node index.js
 */

import { HiveRelayClient } from 'p2p-hiverelay-client'

const relay = new HiveRelayClient('./app-storage')

relay.on('relay-connected', ({ pubkey }) => {
  console.log('Connected to relay:', pubkey.slice(0, 12) + '...')
})

await relay.start()
console.log('HiveRelay client started')

// Option 1: Publish individual files
const drive = await relay.publish([
  { path: '/index.html', content: '<h1>Hello World</h1><p>Served from the P2P relay network.</p>' },
  { path: '/style.css', content: 'body { font-family: system-ui; max-width: 600px; margin: 2rem auto; }' },
  { path: '/manifest.json', content: JSON.stringify({ name: 'node-example', version: '1.0.0' }) }
])

// Option 2: Publish a whole directory (uncomment to use)
// const drive = await relay.publish('./my-website')

console.log('Published! Key:', drive.key.toString('hex'))

// Request seeding so relays persist your content
await relay.seed(drive.key.toString('hex'), { replicationFactor: 3 })
console.log('Seed request sent')

// Check relay status
const relays = relay.getRelays()
console.log(`Connected to ${relays.length} relay(s)`)

// Call a service on the relay
try {
  const identity = await relay.callService('identity', 'whoami')
  console.log('Relay identity:', identity.name || identity.pubkey?.slice(0, 12) + '...')
} catch {
  console.log('(Service RPC not available on connected relays)')
}

// List available apps across the network. Each row is one (app, relay) pair —
// per-relay catalogs are local to each operator (no global merged view).
const apps = relay.getAvailableApps()
if (apps.length > 0) {
  console.log(`\n${apps.length} app row(s) across connected relays:`)
  for (const app of apps) {
    const id = app.appId || app.appKey.slice(0, 12) + '...'
    console.log(`  - ${id} (from relay ${app.source.relayPubkey.slice(0, 12)})`)
  }
}

console.log('\nApp is running. Press Ctrl+C to stop.')
console.log('Your content stays available on relay nodes after you quit.')

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...')
  await relay.destroy()
  process.exit(0)
})
