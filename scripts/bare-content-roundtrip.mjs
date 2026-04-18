#!/usr/bin/env node
/**
 * Content round-trip test: prove that a DIFFERENT client can retrieve
 * content from the Bare relay, with the original publisher offline.
 *
 * Steps:
 *   1. Client A publishes a drive with known content
 *   2. Client A seeds to Bare relay
 *   3. Client A destroys (goes offline)
 *   4. Client B (fresh, no shared state) opens the drive by key
 *   5. Client B reads the content and verifies it matches
 *
 * This is the real proof of always-on availability.
 */

import { HiveRelayClient } from '../client/index.js'
import { rmSync } from 'fs'

const BARE_PK = process.env.BARE_PK
if (!BARE_PK) { console.error('BARE_PK required'); process.exit(1) }

const KNOWN_CONTENT = 'BARE_RELAY_ROUNDTRIP_TEST_' + Date.now() + '_' + Math.random()
console.log('[test] marker content:', KNOWN_CONTENT.slice(0, 60))

// ─── Client A: publish + seed ───────────────────────────────────

const storeA = '/tmp/roundtrip-A-' + Date.now()
rmSync(storeA, { recursive: true, force: true })
console.log('\n[A] starting Client A (publisher)')
const A = new HiveRelayClient(storeA)
await A.start()

console.log('[A] waiting 5s for relay discovery...')
await new Promise(r => setTimeout(r, 5000))

// Wait for Bare relay specifically
let tries = 0
while (!A.relays.has(BARE_PK) && tries++ < 30) {
  await new Promise(r => setTimeout(r, 500))
}
if (!A.relays.has(BARE_PK)) {
  console.error('[A] ✗ never connected to Bare relay')
  process.exit(1)
}
console.log('[A] ✓ connected to Bare relay')

const { key: driveKey } = await A.publish([
  { path: '/marker.txt', content: KNOWN_CONTENT }
], { appId: 'roundtrip-' + Date.now() })
const keyHex = typeof driveKey === 'string' ? driveKey : driveKey.toString('hex')
console.log('[A] published drive:', keyHex.slice(0, 16) + '…')

const acks = await A.seed(driveKey, { replicas: 3, timeout: 20000 })
console.log('[A] seed broadcast received', acks.length, 'signed acceptances')
await new Promise(r => setTimeout(r, 3000)) // let replication settle

console.log('[A] going offline')
await A.destroy()

// ─── Client B: fresh storage, try to read from the network ─────

console.log('\n[B] starting Client B (reader, no shared state with A)')
const storeB = '/tmp/roundtrip-B-' + Date.now()
rmSync(storeB, { recursive: true, force: true })
const B = new HiveRelayClient(storeB)
await B.start()

console.log('[B] waiting 5s for relay discovery...')
await new Promise(r => setTimeout(r, 5000))

console.log('[B] opening drive by key:', keyHex.slice(0, 16) + '…')
const drive = await B.open(keyHex)

console.log('[B] reading /marker.txt …')
try {
  const content = await B.get(keyHex, '/marker.txt')
  const text = typeof content === 'string' ? content : content.toString('utf-8')
  if (text === KNOWN_CONTENT) {
    console.log('[B] ✅ CONTENT MATCHES — round-trip successful')
    console.log('\n✅ AIRTIGHT: Client B retrieved Client A\'s content with A offline.')
    await B.destroy()
    process.exit(0)
  } else {
    console.log('[B] ✗ content mismatch:')
    console.log('   expected:', KNOWN_CONTENT.slice(0, 80))
    console.log('   got:     ', text.slice(0, 80))
    await B.destroy()
    process.exit(1)
  }
} catch (e) {
  console.log('[B] ✗ read failed:', e.message)
  await B.destroy()
  process.exit(1)
}
