// Milestone 1 test: Node client ↔ Bare relay interop.
// Run the Bare relay (pear run .) in another terminal first, then:
//   node scripts/bare-mesh-test.mjs <bare-relay-pubkey-hex>

import { HiveRelayClient } from '../client/index.js'
import { rmSync } from 'fs'

const targetPubkey = process.argv[2]
if (!targetPubkey) {
  console.error('usage: node scripts/bare-mesh-test.mjs <bare-relay-pubkey-hex>')
  process.exit(1)
}

const storage = '/tmp/hr-mesh-test-' + Date.now()
rmSync(storage, { recursive: true, force: true })

console.log('[client] starting with storage:', storage)
const client = new HiveRelayClient(storage)
await client.start()

console.log('[client] waiting for relay discovery…')
await new Promise((resolve) => {
  let done = false
  const onConn = (evt) => {
    const pk = evt.pubkey || evt.remotePubKey || ''
    if (pk === targetPubkey || targetPubkey.startsWith(pk.slice(0, 16))) {
      if (done) return; done = true
      console.log('[client]  ✓ connected to Bare relay:', pk.slice(0, 16) + '...')
      client.off('relay-connected', onConn)
      resolve()
    }
  }
  client.on('relay-connected', onConn)
  setTimeout(() => {
    if (done) return; done = true
    console.log('[client]  (did not see specific pubkey; continuing — may still be accepted)')
    client.off('relay-connected', onConn)
    resolve()
  }, 30000)
})

console.log('[client] relays currently connected:', client.relays.size)
for (const [pk, rel] of client.relays) {
  console.log('  -', pk.slice(0, 16), '...')
}

console.log('[client] publishing a test drive…')
const files = [
  { path: '/hello.txt', content: 'Hello from a Node client! The Bare relay is storing me.' },
  { path: '/manifest.json', content: JSON.stringify({ name: 'Bare Mesh Test', ts: new Date().toISOString() }) }
]
const { key } = await client.publish(files, { appId: 'bare-mesh-test-' + Date.now() })
console.log('[client] drive key:', key)

console.log('[client] broadcasting seed request (replicas=1)…')
const accepted = await client.seed(key, { replicas: 1, timeout: 25000 })
console.log('[client] acceptances:', accepted.length)
for (const acc of accepted) {
  const pk = acc.relayPubkey ? (typeof acc.relayPubkey === 'string' ? acc.relayPubkey : acc.relayPubkey.toString('hex')) : 'unsigned'
  const match = pk === targetPubkey || targetPubkey.startsWith(pk.slice(0, 16))
  console.log(`[client]  ${match ? '🎉' : ' •'} accepted by: ${pk.slice(0, 16)}...${match ? '  ← BARE RELAY' : ''}`)
}

console.log('[client] waiting 3s for replication to settle…')
await new Promise(r => setTimeout(r, 3000))
await client.destroy()
const matchedBare = accepted.some(a => {
  const pk = a.relayPubkey ? (typeof a.relayPubkey === 'string' ? a.relayPubkey : a.relayPubkey.toString('hex')) : ''
  return pk.startsWith(targetPubkey.slice(0, 16))
})
console.log(matchedBare ? '\n✅ MILESTONE 1: Bare relay accepted and stored Node-published content.\n' : '\n⚠️  MILESTONE 1: Bare relay was reachable but did not accept this particular seed request in time.\n')
process.exit(matchedBare ? 0 : 2)
