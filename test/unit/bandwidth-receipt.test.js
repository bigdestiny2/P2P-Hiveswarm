import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { BandwidthReceipt } from 'p2p-hiverelay/core/protocol/bandwidth-receipt.js'

function makeKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function randomBuf (n) {
  const buf = b4a.alloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

test('BandwidthReceipt - createReceipt returns correct fields', async (t) => {
  const kp = makeKeyPair()
  const br = new BandwidthReceipt(kp)

  const relayPubkey = randomBuf(32)
  const sessionId = randomBuf(32)
  const receipt = br.createReceipt(relayPubkey, 1024, sessionId)

  t.ok(receipt.relayPubkey, 'has relayPubkey')
  t.ok(receipt.peerPubkey, 'has peerPubkey')
  t.is(receipt.bytesTransferred, 1024)
  t.ok(receipt.timestamp > 0, 'has timestamp')
  t.ok(receipt.sessionId, 'has sessionId')
  t.is(receipt.peerSignature.byteLength, 64, 'signature is 64 bytes')
})

test('BandwidthReceipt - verify valid receipt', async (t) => {
  const kp = makeKeyPair()
  const br = new BandwidthReceipt(kp)

  const receipt = br.createReceipt(randomBuf(32), 2048, randomBuf(32))
  t.ok(BandwidthReceipt.verify(receipt), 'valid receipt verifies')
})

test('BandwidthReceipt - verify fails for tampered receipt', async (t) => {
  const kp = makeKeyPair()
  const br = new BandwidthReceipt(kp)

  const receipt = br.createReceipt(randomBuf(32), 2048, randomBuf(32))
  receipt.bytesTransferred = 9999 // tamper

  t.ok(!BandwidthReceipt.verify(receipt), 'tampered receipt fails verification')
})

test('BandwidthReceipt - collectReceipt accepts valid', async (t) => {
  const peerKp = makeKeyPair()
  const relayKp = makeKeyPair()

  const peer = new BandwidthReceipt(peerKp)
  const relay = new BandwidthReceipt(relayKp)

  const receipt = peer.createReceipt(relayKp.publicKey, 512, randomBuf(32))
  const ok = relay.collectReceipt(receipt)

  t.ok(ok, 'collectReceipt returned true')
  t.is(relay.collectedReceipts.length, 1)
})

test('BandwidthReceipt - collectReceipt rejects invalid', async (t) => {
  t.plan(2)
  const relayKp = makeKeyPair()
  const relay = new BandwidthReceipt(relayKp)

  relay.on('receipt-invalid', () => {
    t.pass('receipt-invalid emitted')
  })

  // Forge a receipt with bad signature
  const fakeReceipt = {
    relayPubkey: relayKp.publicKey,
    peerPubkey: randomBuf(32),
    bytesTransferred: 100,
    timestamp: Math.floor(Date.now() / 1000),
    sessionId: randomBuf(32),
    peerSignature: randomBuf(64) // random bytes, not a valid signature
  }

  const ok = relay.collectReceipt(fakeReceipt)
  t.ok(!ok, 'collectReceipt returned false')
})

test('BandwidthReceipt - getTotalProvenBandwidth', async (t) => {
  const peerKp = makeKeyPair()
  const relayKp = makeKeyPair()

  const peer = new BandwidthReceipt(peerKp)
  const relay = new BandwidthReceipt(relayKp)

  relay.collectReceipt(peer.createReceipt(relayKp.publicKey, 100, randomBuf(32)))
  relay.collectReceipt(peer.createReceipt(relayKp.publicKey, 200, randomBuf(32)))
  relay.collectReceipt(peer.createReceipt(relayKp.publicKey, 300, randomBuf(32)))

  t.is(relay.getTotalProvenBandwidth(), 600)
})

test('BandwidthReceipt - maxReceipts cap', async (t) => {
  const kp = makeKeyPair()
  const br = new BandwidthReceipt(kp, { maxReceipts: 5 })

  for (let i = 0; i < 10; i++) {
    br.createReceipt(randomBuf(32), i * 100, randomBuf(32))
  }

  t.is(br.issuedReceipts.length, 5, 'issued receipts capped at 5')

  // Collected receipts cap
  const relay = new BandwidthReceipt(makeKeyPair(), { maxReceipts: 3 })
  for (let i = 0; i < 7; i++) {
    const receipt = br.createReceipt(relay.keyPair.publicKey, 50, randomBuf(32))
    relay.collectReceipt(receipt)
  }

  t.is(relay.collectedReceipts.length, 3, 'collected receipts capped at 3')
})
