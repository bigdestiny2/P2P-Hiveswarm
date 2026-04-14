/**
 * Live ZK Service Test — connects to the relay network and tests
 * all ZK primitives over P2P via callService().
 *
 * Usage: node scripts/test-zk-live.js
 */

import { HiveRelayClient } from '../client/index.js'

const TIMEOUT = 15000

console.log('=== HiveRelay Live ZK Test ===\n')

const client = new HiveRelayClient('./test-zk-storage')

client.on('relay-connected', ({ pubkey }) => {
  console.log('  Connected to relay:', pubkey.slice(0, 12) + '...')
})

await client.start()
console.log('Client started, waiting for relay connections...\n')

// Wait for at least one relay
await new Promise((resolve) => {
  if (client.getRelays().length > 0) return resolve()
  client.on('relay-connected', resolve)
  setTimeout(() => resolve(), 10000)
})

const relays = client.getRelays()
if (relays.length === 0) {
  console.log('ERROR: No relays found. Is the network running?')
  await client.destroy()
  process.exit(1)
}

console.log(`Connected to ${relays.length} relay(s)\n`)

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

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'assertion failed')
}

// ─── Service Catalog ────────────────────────────────────────────────

console.log('--- Service Discovery ---')

await test('service catalog includes zk', async () => {
  const catalog = client.getServiceCatalog()
  const relayKey = Object.keys(catalog)[0]
  assert(relayKey, 'no catalog received')
  const services = catalog[relayKey]
  const zk = services.find(s => s.name === 'zk')
  assert(zk, 'zk service not in catalog')
  assert(zk.version === '2.0.0', 'expected zk v2.0.0, got ' + zk.version)
  console.log('    ZK service v' + zk.version + ' — ' + zk.capabilities.length + ' capabilities')
})

// ─── Pedersen Commitments ───────────────────────────────────────────

console.log('\n--- Pedersen Commitments ---')

await test('commit to a bet amount', async () => {
  const result = await client.callService('zk', 'commit', { value: 5000 })
  assert(result.commitment, 'no commitment returned')
  assert(result.commitment.length === 66, 'commitment should be 66 hex chars (compressed point)')
  assert(result.blindingFactor, 'no blinding factor')
  assert(result.blindingFactor.length === 64, 'blinding factor should be 64 hex chars')
})

await test('verify commitment opens correctly', async () => {
  const { commitment, blindingFactor } = await client.callService('zk', 'commit', { value: 'my-secret-hand' })
  const valid = await client.callService('zk', 'verify-commit', { commitment, value: 'my-secret-hand', blindingFactor })
  assert(valid.valid === true, 'valid commitment should verify')
})

await test('commitment binding — wrong value rejected', async () => {
  const { commitment, blindingFactor } = await client.callService('zk', 'commit', { value: 100 })
  const invalid = await client.callService('zk', 'verify-commit', { commitment, value: 200, blindingFactor })
  assert(invalid.valid === false, 'wrong value should not verify')
})

// ─── Schnorr Proofs ─────────────────────────────────────────────────

console.log('\n--- Schnorr NIZK Proofs ---')

await test('prove knowledge of a secret', async () => {
  const secret = '0a' + '0'.repeat(62)
  const result = await client.callService('zk', 'prove-knowledge', { secret })
  assert(result.proof, 'no proof returned')
  assert(result.proof.R.length === 66, 'R should be compressed point')
  assert(result.publicPoint.length === 66, 'publicPoint should be compressed point')
})

await test('verify valid proof', async () => {
  const secret = '0b' + '0'.repeat(62)
  const { proof, publicPoint } = await client.callService('zk', 'prove-knowledge', { secret })
  const result = await client.callService('zk', 'verify-knowledge', { proof, publicPoint })
  assert(result.valid === true, 'valid proof should verify')
})

// ─── Mental Poker (Card Encryption) ─────────────────────────────────

console.log('\n--- Mental Poker (ElGamal Cards) ---')

const playerSecret = '07' + '0'.repeat(62)
let playerPubKey

await test('generate player keypair', async () => {
  const { publicPoint } = await client.callService('zk', 'prove-knowledge', { secret: playerSecret })
  playerPubKey = publicPoint
  assert(playerPubKey.length === 66, 'pubkey should be 66 hex')
  console.log('    Player pubkey: ' + playerPubKey.slice(0, 20) + '...')
})

let encryptedCard

await test('encrypt card (Ace of Spades = card 0)', async () => {
  const result = await client.callService('zk', 'encrypt-card', { card: 0, publicKey: playerPubKey })
  encryptedCard = result.encrypted
  assert(encryptedCard.c1, 'no c1 in encrypted card')
  assert(encryptedCard.c2, 'no c2 in encrypted card')
  assert(encryptedCard.c1.length === 66, 'c1 should be compressed point')
})

let revealToken

await test('create reveal token with DLEQ proof', async () => {
  const result = await client.callService('zk', 'create-reveal-token', {
    encrypted: encryptedCard,
    secretKey: playerSecret
  })
  revealToken = result.token
  assert(result.token, 'no token returned')
  assert(result.proof, 'no DLEQ proof returned')
  assert(result.proof.e, 'DLEQ proof missing e')
  assert(result.proof.s, 'DLEQ proof missing s')
})

await test('unmask card — reveals Ace of Spades (card 0)', async () => {
  const result = await client.callService('zk', 'unmask-card', {
    encrypted: encryptedCard,
    tokens: [revealToken]
  })
  assert(result.card === 0, 'expected card 0 (Ace of Spades), got ' + result.card)
  console.log('    Revealed card: ' + result.card + ' (Ace of Spades)')
})

await test('encrypt and unmask card 51 (King of Clubs)', async () => {
  const { encrypted } = await client.callService('zk', 'encrypt-card', { card: 51, publicKey: playerPubKey })
  const { token } = await client.callService('zk', 'create-reveal-token', { encrypted, secretKey: playerSecret })
  const { card } = await client.callService('zk', 'unmask-card', { encrypted, tokens: [token] })
  assert(card === 51, 'expected card 51, got ' + card)
  console.log('    Revealed card: ' + card + ' (King of Clubs)')
})

// ─── Fair Randomness ────────────────────────────────────────────────

console.log('\n--- Fair Randomness (Coin Flip) ---')

await test('3-player commit-reveal coin flip', async () => {
  // Each player commits
  const p1 = await client.callService('zk', 'commit-random')
  const p2 = await client.callService('zk', 'commit-random')
  const p3 = await client.callService('zk', 'commit-random')

  assert(p1.commitment, 'p1 missing commitment')
  assert(p2.secret, 'p2 missing secret')

  // All reveal
  const result = await client.callService('zk', 'combine-reveals', {
    reveals: [
      { secret: p1.secret, commitment: p1.commitment },
      { secret: p2.secret, commitment: p2.commitment },
      { secret: p3.secret, commitment: p3.commitment }
    ]
  })
  assert(result.valid === true, 'reveals should be valid')
  assert(result.randomValue, 'no random value')
  assert(result.randomValue.length === 64, 'random value should be 32 bytes hex')
  console.log('    Random result: ' + result.randomValue.slice(0, 16) + '...')
})

await test('detect cheater in coin flip', async () => {
  const honest = await client.callService('zk', 'commit-random')
  const result = await client.callService('zk', 'combine-reveals', {
    reveals: [
      { secret: 'ff'.repeat(32), commitment: honest.commitment } // wrong secret
    ]
  })
  assert(result.valid === false, 'should detect cheater')
  assert(result.failedIndex === 0, 'should identify cheater index')
})

// ─── Membership Proofs ──────────────────────────────────────────────

console.log('\n--- ZK Membership Proofs ---')

await test('prove membership without revealing value', async () => {
  const proof = await client.callService('zk', 'prove-membership', {
    value: 'carol',
    set: ['alice', 'bob', 'carol', 'dave']
  })
  assert(proof.leafHash, 'no leafHash')
  assert(proof.merkleRoot, 'no merkleRoot')

  // Verify WITHOUT the original value
  const result = await client.callService('zk', 'verify-membership', {
    leafHash: proof.leafHash,
    merkleRoot: proof.merkleRoot,
    proof: proof.proof,
    leafIndex: proof.leafIndex
  })
  assert(result.valid === true, 'membership proof should verify')
})

// ─── Range Proofs ───────────────────────────────────────────────────

console.log('\n--- ZK Range Proofs ---')

await test('prove value in range without revealing it', async () => {
  const proof = await client.callService('zk', 'prove-range', {
    value: 25,
    min: 18,
    max: 65
  })
  assert(proof.commitment, 'no commitment')
  assert(proof.rangeProof, 'no rangeProof')

  // Verify WITHOUT the value
  const result = await client.callService('zk', 'verify-range', {
    commitment: proof.commitment,
    rangeProof: proof.rangeProof
  })
  assert(result.valid === true, 'range proof should verify')
})

// ─── Circuit Listing ────────────────────────────────────────────────

console.log('\n--- Available Circuits ---')

await test('list all ZK circuits', async () => {
  const result = await client.callService('zk', 'circuits')
  assert(result.available.length === 7, 'expected 7 built-in circuits, got ' + result.available.length)
  assert(result.curve === 'secp256k1', 'expected secp256k1 curve')
  console.log('    ' + result.available.map(c => c.name).join(', '))
})

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log('='.repeat(50))

await client.destroy()
process.exit(failed > 0 ? 1 : 0)
