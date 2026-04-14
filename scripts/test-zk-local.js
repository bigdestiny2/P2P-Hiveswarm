/**
 * Local ZK Service Test — spins up a testnet relay + client
 * and tests all ZK primitives over P2P via callService().
 *
 * Usage: node scripts/test-zk-local.js
 */

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import { RelayNode } from '../core/relay-node/index.js'
import { HiveRelayClient } from '../client/index.js'
import createTestnet from '@hyperswarm/testnet'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

console.log('=== Local ZK P2P Service Test ===\n')

const testnet = await createTestnet(3)
const relayStorage = join(tmpdir(), 'zk-relay-' + randomBytes(4).toString('hex'))

// Start relay with services + router
const node = new RelayNode({
  storage: relayStorage,
  bootstrapNodes: testnet.bootstrap,
  enableAPI: false,
  enableMetrics: false,
  enableServices: true,
  enableRouter: true
})

await node.start()
await node.swarm.flush()
console.log('Relay started')
console.log('  Services registered:', node.serviceRegistry?.services?.size || 0)
console.log('  Router routes:', node.router?.routes()?.length || 0)

// Start client with its own swarm (matches working integration test pattern)
const clientSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
const clientStore = new Corestore(join(tmpdir(), 'zk-client-' + randomBytes(4).toString('hex')))
const client = new HiveRelayClient({ swarm: clientSwarm, store: clientStore })

await client.start()

// Poll for relay connection (DHT discovery can take a few seconds)
for (let i = 0; i < 20; i++) {
  if (client.relays.size > 0) break
  await new Promise(r => setTimeout(r, 500))
  await clientSwarm.flush()
}

console.log('Client connected to', client.getRelays().length, 'relay(s)')

// Wait for service channel to open
await new Promise(r => {
  for (const [, relay] of client.relays) {
    if (relay.channels?.service) return r()
  }
  client.on('service-channel-open', () => r())
  setTimeout(r, 3000)
})

let passed = 0
let failed = 0

async function test (name, fn) {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}: ${err.message}`)
  }
}

// ─── Pedersen Commitments ───────────────────────────────────────────

console.log('\n--- Pedersen Commitments (over P2P) ---')

await test('commit to bet amount (5000 sats)', async () => {
  const r = await client.callService('zk', 'commit', { value: 5000 })
  if (!r.commitment || r.commitment.length !== 66) throw new Error('bad commitment')
  if (!r.blindingFactor || r.blindingFactor.length !== 64) throw new Error('bad blinding')
})

await test('verify commitment opens correctly', async () => {
  const { commitment, blindingFactor } = await client.callService('zk', 'commit', { value: 'royal-flush' })
  const v = await client.callService('zk', 'verify-commit', { commitment, value: 'royal-flush', blindingFactor })
  if (!v.valid) throw new Error('valid commitment should verify')
})

await test('wrong value rejected (binding property)', async () => {
  const { commitment, blindingFactor } = await client.callService('zk', 'commit', { value: 100 })
  const v = await client.callService('zk', 'verify-commit', { commitment, value: 999, blindingFactor })
  if (v.valid) throw new Error('wrong value should fail')
})

// ─── Schnorr Proofs ─────────────────────────────────────────────────

console.log('\n--- Schnorr NIZK Proofs (over P2P) ---')

await test('prove + verify knowledge of secret', async () => {
  const secret = '0a' + '0'.repeat(62)
  const { proof, publicPoint } = await client.callService('zk', 'prove-knowledge', { secret })
  const v = await client.callService('zk', 'verify-knowledge', { proof, publicPoint })
  if (!v.valid) throw new Error('valid proof should verify')
})

// ─── Mental Poker ───────────────────────────────────────────────────

console.log('\n--- Mental Poker Cards (over P2P) ---')

const sk = '07' + '0'.repeat(62)
let pk, encrypted

await test('encrypt card 7 (Eight of Spades)', async () => {
  const kp = await client.callService('zk', 'prove-knowledge', { secret: sk })
  pk = kp.publicPoint
  const r = await client.callService('zk', 'encrypt-card', { card: 7, publicKey: pk })
  encrypted = r.encrypted
  if (!encrypted.c1 || !encrypted.c2) throw new Error('bad encryption')
})

await test('reveal token + DLEQ proof', async () => {
  const r = await client.callService('zk', 'create-reveal-token', { encrypted, secretKey: sk })
  if (!r.token || !r.proof) throw new Error('missing token or proof')
})

await test('unmask → card 7', async () => {
  const { token } = await client.callService('zk', 'create-reveal-token', { encrypted, secretKey: sk })
  const r = await client.callService('zk', 'unmask-card', { encrypted, tokens: [token] })
  if (r.card !== 7) throw new Error('expected card 7, got ' + r.card)
  console.log('    Dealt card: 7 (Eight of Spades)')
})

await test('full deal: encrypt card 0 → unmask → Ace of Spades', async () => {
  const { encrypted: enc } = await client.callService('zk', 'encrypt-card', { card: 0, publicKey: pk })
  const { token } = await client.callService('zk', 'create-reveal-token', { encrypted: enc, secretKey: sk })
  const { card } = await client.callService('zk', 'unmask-card', { encrypted: enc, tokens: [token] })
  if (card !== 0) throw new Error('expected card 0, got ' + card)
  console.log('    Dealt card: 0 (Ace of Spades)')
})

// ─── Fair Randomness ────────────────────────────────────────────────

console.log('\n--- Fair Coin Flip (over P2P) ---')

await test('3-player fair random', async () => {
  const p1 = await client.callService('zk', 'commit-random')
  const p2 = await client.callService('zk', 'commit-random')
  const p3 = await client.callService('zk', 'commit-random')
  const r = await client.callService('zk', 'combine-reveals', {
    reveals: [
      { secret: p1.secret, commitment: p1.commitment },
      { secret: p2.secret, commitment: p2.commitment },
      { secret: p3.secret, commitment: p3.commitment }
    ]
  })
  if (!r.valid) throw new Error('reveals should be valid')
  console.log('    Random: ' + r.randomValue.slice(0, 16) + '...')
})

// ─── Membership + Range ─────────────────────────────────────────────

console.log('\n--- ZK Proofs (over P2P) ---')

await test('membership proof (no plaintext in verify)', async () => {
  const p = await client.callService('zk', 'prove-membership', { value: 'bob', set: ['alice', 'bob', 'carol'] })
  const v = await client.callService('zk', 'verify-membership', {
    leafHash: p.leafHash, merkleRoot: p.merkleRoot, proof: p.proof, leafIndex: p.leafIndex
  })
  if (!v.valid) throw new Error('membership proof should verify')
})

await test('range proof (no plaintext in verify)', async () => {
  const p = await client.callService('zk', 'prove-range', { value: 25, min: 18, max: 65 })
  const v = await client.callService('zk', 'verify-range', { commitment: p.commitment, rangeProof: p.rangeProof })
  if (!v.valid) throw new Error('range proof should verify')
})

await test('list circuits', async () => {
  const c = await client.callService('zk', 'circuits')
  if (c.available.length !== 7) throw new Error('expected 7 circuits, got ' + c.available.length)
  if (c.curve !== 'secp256k1') throw new Error('expected secp256k1')
  console.log('    Circuits: ' + c.available.map(a => a.name).join(', '))
})

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('All calls made over Hyperswarm P2P via callService()')
console.log('='.repeat(50))

await client.destroy()
await clientSwarm.destroy()
await node.stop()
await testnet.destroy()
process.exit(failed > 0 ? 1 : 0)
