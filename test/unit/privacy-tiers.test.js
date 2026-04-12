/**
 * Privacy Tiers Test Suite
 * =========================
 * Tests the block storage use case through all 3 privacy tiers.
 *
 * For each tier, we:
 *   1. Create a PrivacyManager with the appropriate manifest
 *   2. Store financial transaction data (the sensitive use case)
 *   3. Verify what's encrypted vs plaintext
 *   4. Check what the relay would see
 *   5. Test sync export/import
 *   6. Generate a privacy audit report
 */

import test from 'brittle'
import b4a from 'b4a'
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'fs'
import { rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PrivacyManager } from '../../platform/privacy.js'
import { KeyManager } from '../../platform/keys.js'
import { LocalStorage } from '../../platform/storage.js'
import { encrypt, decrypt, generateKey, hash } from '../../platform/crypto.js'

// ── Helpers ─────────────────────────────────────────���───────

function tmpPath (name) {
  const dir = join(tmpdir(), `hiverelay-privacy-test-${name}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Sample financial transaction data (the sensitive use case)
function sampleTransactions () {
  return [
    { id: 'tx-001', type: 'payment', from: 'alice', to: 'bob', amount: 50000, currency: 'sats', memo: 'rent', timestamp: Date.now() },
    { id: 'tx-002', type: 'payment', from: 'alice', to: 'coffee-shop', amount: 450, currency: 'sats', memo: 'latte', timestamp: Date.now() },
    { id: 'tx-003', type: 'receive', from: 'employer', to: 'alice', amount: 2000000, currency: 'sats', memo: 'salary', timestamp: Date.now() },
    { id: 'tx-004', type: 'payment', from: 'alice', to: 'pharmacy', amount: 4750, currency: 'sats', memo: 'prescription', timestamp: Date.now() },
    { id: 'tx-005', type: 'payment', from: 'alice', to: 'therapist', amount: 15000, currency: 'sats', memo: 'session', timestamp: Date.now() }
  ]
}

// ── Crypto API Tests ────────────────────────────────────────

test('crypto: encrypt and decrypt round-trip', async (t) => {
  const key = generateKey()
  const plaintext = b4a.from('Hello, privacy!')
  const sealed = encrypt(plaintext, key)

  t.ok(sealed.length > plaintext.length, 'Ciphertext longer than plaintext (nonce + tag)')
  t.ok(!b4a.equals(sealed.subarray(24), plaintext), 'Ciphertext is not plaintext')

  const decrypted = decrypt(sealed, key)
  t.ok(b4a.equals(decrypted, plaintext), 'Decrypted matches original')
})

test('crypto: wrong key fails decryption', async (t) => {
  const key1 = generateKey()
  const key2 = generateKey()
  const sealed = encrypt(b4a.from('secret'), key1)

  try {
    decrypt(sealed, key2)
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Decryption failed'), 'Throws on wrong key')
  }
})

test('crypto: tampered ciphertext fails', async (t) => {
  const key = generateKey()
  const sealed = encrypt(b4a.from('secret'), key)

  // Flip a byte in the ciphertext
  sealed[30] ^= 0xff

  try {
    decrypt(sealed, key)
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Decryption failed'), 'Detects tampering')
  }
})

test('crypto: large data encrypt/decrypt (1MB)', async (t) => {
  const key = generateKey()
  const data = b4a.alloc(1024 * 1024)
  for (let i = 0; i < data.length; i++) data[i] = i % 256

  const sealed = encrypt(data, key)
  const decrypted = decrypt(sealed, key)
  t.ok(b4a.equals(decrypted, data), '1MB round-trip successful')
})

// ── Key Management Tests ────────────────────────────────────

test('keys: device key generation and persistence', async (t) => {
  const dir = tmpPath('keys')
  const km = new KeyManager(dir)
  await km.init()

  const key1 = km.device()
  t.is(key1.length, 32, 'Device key is 32 bytes')

  // Reload — should get same key
  const km2 = new KeyManager(dir)
  await km2.init()
  t.ok(b4a.equals(km2.device(), key1), 'Persisted key matches')

  km.destroy()
  km2.destroy()
})

test('keys: hierarchical derivation produces deterministic keys', async (t) => {
  const dir = tmpPath('keys-derive')
  const km = new KeyManager(dir)
  await km.init()

  const appKey1 = km.appKey('sanduq')
  const appKey2 = km.appKey('sanduq')
  t.ok(b4a.equals(appKey1, appKey2), 'Same app name → same key')

  const appKey3 = km.appKey('bazaar')
  t.ok(!b4a.equals(appKey1, appKey3), 'Different app → different key')

  const dataKey1 = km.dataKey('sanduq', 'transactions')
  const dataKey2 = km.dataKey('sanduq', 'profile')
  t.ok(!b4a.equals(dataKey1, dataKey2), 'Different purpose → different key')

  km.destroy()
})

test('keys: destroy zeros out key material', async (t) => {
  const dir = tmpPath('keys-destroy')
  const km = new KeyManager(dir)
  await km.init()

  const key = km.device()
  t.ok(key.some(b => b !== 0), 'Key has non-zero bytes before destroy')

  km.destroy()
  t.ok(key.every(b => b === 0), 'Key zeroed after destroy')
  t.is(km.deviceKey, null, 'deviceKey set to null')
})

// ── Local Storage Tests ─────────────────────────────────────

test('storage: encrypted store and retrieve', async (t) => {
  const dir = tmpPath('storage')
  const key = generateKey()
  const store = new LocalStorage({ path: dir, name: 'test-app', key })
  await store.init()

  await store.set('secret', 'my sensitive data')
  const data = await store.get('secret')
  t.is(data.toString(), 'my sensitive data', 'Retrieved matches stored')

  // Verify the file on disk is encrypted (not plaintext)
  const files = readdirSync(join(dir, 'test-app')).filter(f => f.endsWith('.enc'))
  t.ok(files.length > 0, 'Encrypted file exists on disk')

  const rawBytes = readFileSync(join(dir, 'test-app', files[0]))
  t.ok(!rawBytes.includes('my sensitive data'), 'Disk file does NOT contain plaintext')
})

test('storage: JSON round-trip', async (t) => {
  const dir = tmpPath('storage-json')
  const key = generateKey()
  const store = new LocalStorage({ path: dir, name: 'test', key })
  await store.init()

  const tx = { from: 'alice', to: 'bob', amount: 50000 }
  await store.set('tx-001', tx)

  const retrieved = await store.getJSON('tx-001')
  t.is(retrieved.from, 'alice')
  t.is(retrieved.amount, 50000)
})

test('storage: quota enforcement', async (t) => {
  const dir = tmpPath('storage-quota')
  const key = generateKey()
  const store = new LocalStorage({ path: dir, name: 'test', key, quota: 100 })
  await store.init()

  await store.set('small', 'abc')

  try {
    await store.set('big', 'x'.repeat(200))
    t.fail('Should have thrown quota error')
  } catch (err) {
    t.ok(err.message.includes('quota exceeded'), 'Quota enforced')
  }
})

test('storage: export encrypted blobs for P2P backup', async (t) => {
  const dir = tmpPath('storage-export')
  const key = generateKey()
  const store = new LocalStorage({ path: dir, name: 'test', key })
  await store.init()

  await store.set('tx-001', { amount: 100 })
  await store.set('tx-002', { amount: 200 })

  const blobs = await store.exportEncrypted()
  t.is(blobs.size, 2, 'Exported 2 blobs')

  // Verify blobs are encrypted
  for (const [k, blob] of blobs) {
    t.ok(b4a.isBuffer(blob), 'Blob is a buffer')
    t.ok(!blob.toString().includes('amount'), 'Blob is not plaintext')
  }

  // Import into a new store with same key
  const dir2 = tmpPath('storage-import')
  const store2 = new LocalStorage({ path: dir2, name: 'test', key })
  await store2.init()

  const result = await store2.importEncrypted(blobs)
  t.is(result.imported, 2, 'Imported 2 blobs')

  const tx = await store2.getJSON('tx-001')
  t.is(tx.amount, 100, 'Imported data matches')
})

test('storage: wrong key cannot import blobs', async (t) => {
  const dir = tmpPath('storage-wrongkey')
  const key1 = generateKey()
  const key2 = generateKey()
  const store1 = new LocalStorage({ path: dir, name: 'test', key: key1 })
  await store1.init()

  await store1.set('secret', 'private data')
  const blobs = await store1.exportEncrypted()

  const dir2 = tmpPath('storage-wrongkey2')
  const store2 = new LocalStorage({ path: dir2, name: 'test', key: key2 })
  await store2.init()

  const result = await store2.importEncrypted(blobs)
  t.is(result.imported, 0, 'Zero imports with wrong key')
  t.is(result.failed, 1, 'One failure with wrong key')
})

// ── Privacy Tier: PUBLIC ────────────────────────────────────

test('tier PUBLIC: data goes to relay in plaintext', async (t) => {
  const dir = tmpPath('tier-public')
  const pm = new PrivacyManager({
    appName: 'bazaar',
    privacyTier: 'public'
  }, dir)
  await pm.init()

  const txs = sampleTransactions()

  // Store transactions
  for (const tx of txs) {
    const result = await pm.store(`tx-${tx.id}`, tx, { classification: 'sensitive' })
    t.is(result.encrypted, false, 'Public tier: data NOT encrypted')
    t.is(result.location, 'relay', 'Public tier: data goes to relay')
    t.ok(result.data, 'Public tier: data returned for relay storage')

    // Verify the relay can read the data
    const parsed = JSON.parse(result.data.toString())
    t.is(parsed.from, tx.from, 'Relay sees sender')
    t.is(parsed.amount, tx.amount, 'Relay sees amount')
    t.is(parsed.memo, tx.memo, 'Relay sees memo')
  }

  // Check audit warnings
  const report = pm.getPrivacyReport()
  t.is(report.tier, 'public')
  t.is(report.stores.plaintext, 5, '5 plaintext stores')
  t.is(report.stores.encrypted, 0, '0 encrypted stores')
  t.ok(report.warnings > 0, 'Warnings generated for sensitive data in public tier')
  t.is(report.relayExposure, 'FULL — relay sees all data')

  // Validate operations
  t.ok(pm.validateOperation('store-on-relay').allowed, 'Can store on relay')
  t.ok(pm.validateOperation('send-plaintext-to-relay').allowed, 'Can send plaintext')

  pm.destroy()
})

// ── Privacy Tier: LOCAL-FIRST ───────────────────────────────

test('tier LOCAL-FIRST: data encrypted on device, relay sees nothing', async (t) => {
  const dir = tmpPath('tier-local')
  const pm = new PrivacyManager({
    appName: 'sanduq-wallet',
    privacyTier: 'local-first'
  }, dir)
  await pm.init()

  const txs = sampleTransactions()

  // Store transactions
  for (const tx of txs) {
    const result = await pm.store(`tx-${tx.id}`, tx)
    t.is(result.encrypted, true, 'Local-first: data IS encrypted')
    t.is(result.location, 'device', 'Local-first: data stays on device')
    t.is(result.data, null, 'Local-first: no data returned for relay')
  }

  // Retrieve and verify
  for (const tx of txs) {
    const retrieved = await pm.retrieveJSON(`tx-${tx.id}`)
    t.is(retrieved.from, tx.from, 'Can retrieve own data')
    t.is(retrieved.amount, tx.amount, 'Data integrity preserved')
  }

  // Verify disk files are encrypted
  const appDir = join(dir, 'sanduq-wallet')
  if (existsSync(appDir)) {
    const encFiles = readdirSync(appDir).filter(f => f.endsWith('.enc'))
    for (const f of encFiles) {
      const raw = readFileSync(join(appDir, f))
      const rawStr = raw.toString()
      t.ok(!rawStr.includes('alice'), 'Disk: no "alice" in encrypted file')
      t.ok(!rawStr.includes('salary'), 'Disk: no "salary" in encrypted file')
      t.ok(!rawStr.includes('50000'), 'Disk: no "50000" in encrypted file')
    }
  }

  // Audit report
  const report = pm.getPrivacyReport()
  t.is(report.tier, 'local-first')
  t.is(report.stores.encrypted, 5, '5 encrypted stores')
  t.is(report.stores.plaintext, 0, '0 plaintext stores')
  t.is(report.warnings, 0, 'No warnings')
  t.is(report.relayExposure, 'APP CODE ONLY — relay sees app code, never user data')

  // Validate operations
  t.ok(!pm.validateOperation('store-on-relay').allowed, 'CANNOT store on relay')
  t.ok(!pm.validateOperation('send-plaintext-to-relay').allowed, 'CANNOT send plaintext to relay')
  t.ok(pm.validateOperation('store-locally').allowed, 'CAN store locally')
  t.ok(pm.validateOperation('sync-via-p2p').allowed, 'CAN sync via P2P')
  t.ok(!pm.validateOperation('sync-via-relay').allowed, 'CANNOT sync via relay')

  pm.destroy()
})

test('tier LOCAL-FIRST: encrypted P2P sync between devices', async (t) => {
  // Device A stores transactions
  const dirA = tmpPath('tier-local-deviceA')
  const pmA = new PrivacyManager({
    appName: 'sanduq-wallet',
    privacyTier: 'local-first'
  }, dirA)
  await pmA.init()

  const txs = sampleTransactions()
  for (const tx of txs) {
    await pmA.store(`tx-${tx.id}`, tx)
  }

  // Export encrypted blobs (what would go over P2P)
  const blobs = await pmA.prepareSyncExport()
  t.ok(blobs, 'Export produced blobs')
  t.is(blobs.size, 5, '5 encrypted blobs exported')

  // Verify blobs are opaque (relay/attacker can't read them)
  for (const [key, blob] of blobs) {
    const blobStr = blob.toString()
    t.ok(!blobStr.includes('alice'), 'Blob: no "alice"')
    t.ok(!blobStr.includes('salary'), 'Blob: no "salary"')
  }

  // Device B imports (same app, same device key derivation)
  // In reality, device B would have the same device key via backup/recovery
  // For testing, we manually share the key
  const dirB = tmpPath('tier-local-deviceB')
  const pmB = new PrivacyManager({
    appName: 'sanduq-wallet',
    privacyTier: 'local-first'
  }, dirB)
  await pmB.init()

  // Copy device key from A to B (simulating key recovery/sharing)
  const keyFileA = join(dirA, 'device-key.json')
  const keyFileB = join(dirB, 'device-key.json')
  const keyData = readFileSync(keyFileA, 'utf8')
  const { writeFileSync } = await import('fs')
  writeFileSync(keyFileB, keyData, { mode: 0o600 })

  // Reinitialize B with the shared key
  const pmB2 = new PrivacyManager({
    appName: 'sanduq-wallet',
    privacyTier: 'local-first'
  }, dirB)
  await pmB2.init()

  const importResult = await pmB2.importSyncData(blobs)
  t.is(importResult.imported, 5, 'Device B imported all 5 blobs')

  // Verify device B can read the data
  const tx1 = await pmB2.retrieveJSON('tx-tx-001')
  t.is(tx1.from, 'alice', 'Device B can read synced transaction')
  t.is(tx1.amount, 50000, 'Amount preserved')

  pmA.destroy()
  pmB2.destroy()
})

// ── Privacy Tier: P2P-ONLY ──────────────────────────────────

test('tier P2P-ONLY: no relay involvement at all', async (t) => {
  const dir = tmpPath('tier-p2p')
  const pm = new PrivacyManager({
    appName: 'medical-records',
    privacyTier: 'p2p-only'
  }, dir)
  await pm.init()

  const records = [
    { id: 'rec-001', patient: 'alice', diagnosis: 'hypertension', medication: 'lisinopril 10mg' },
    { id: 'rec-002', patient: 'alice', bloodPressure: '140/90', date: '2026-04-10' }
  ]

  // Store records
  for (const rec of records) {
    const result = await pm.store(`rec-${rec.id}`, rec, { classification: 'secret' })
    t.is(result.encrypted, true, 'P2P-only: data IS encrypted')
    t.is(result.location, 'device', 'P2P-only: data stays on device')
    t.is(result.data, null, 'P2P-only: nothing returned for relay')
  }

  // Retrieve
  const rec = await pm.retrieveJSON('rec-rec-001')
  t.is(rec.diagnosis, 'hypertension', 'Can read own medical data')

  // ALL relay operations blocked
  t.ok(!pm.validateOperation('store-on-relay').allowed, 'CANNOT store on relay')
  t.ok(!pm.validateOperation('read-from-relay').allowed, 'CANNOT read from relay')
  t.ok(!pm.validateOperation('sync-via-relay').allowed, 'CANNOT sync via relay')
  t.ok(!pm.validateOperation('send-plaintext-to-relay').allowed, 'CANNOT send plaintext')

  // P2P still works
  t.ok(pm.validateOperation('store-locally').allowed, 'CAN store locally')
  t.ok(pm.validateOperation('sync-via-p2p').allowed, 'CAN sync via P2P')

  // Audit
  const report = pm.getPrivacyReport()
  t.is(report.relayExposure, 'NONE — relay is not involved')
  t.is(report.stores.encrypted, 2)
  t.is(report.stores.plaintext, 0)

  pm.destroy()
})

// ── Cross-Tier Comparison ───────────────────────────────────

test('cross-tier: same data, different exposure', async (t) => {
  const tx = { from: 'alice', to: 'pharmacy', amount: 4750, memo: 'prescription' }

  // Public tier
  const dirPub = tmpPath('cross-public')
  const pmPub = new PrivacyManager({ appName: 'public-app', privacyTier: 'public' }, dirPub)
  await pmPub.init()
  const pubResult = await pmPub.store('tx', tx, { classification: 'sensitive' })

  // Local-first tier
  const dirLocal = tmpPath('cross-local')
  const pmLocal = new PrivacyManager({ appName: 'local-app', privacyTier: 'local-first' }, dirLocal)
  await pmLocal.init()
  const localResult = await pmLocal.store('tx', tx)

  // P2P-only tier
  const dirP2P = tmpPath('cross-p2p')
  const pmP2P = new PrivacyManager({ appName: 'p2p-app', privacyTier: 'p2p-only' }, dirP2P)
  await pmP2P.init()
  const p2pResult = await pmP2P.store('tx', tx)

  // Compare what the relay sees
  t.comment('\n  ╔═══════════════════════════════════════════════════════╗')
  t.comment('  ║  CROSS-TIER COMPARISON: Same pharmacy transaction     ║')
  t.comment('  ╠═══════════════════════════════════════════════════════╣')

  // Public
  t.comment(`  ║  PUBLIC:     Relay sees: ${pubResult.data.toString().slice(0, 50)}...`)
  t.ok(pubResult.data.toString().includes('pharmacy'), 'Public: relay sees "pharmacy"')
  t.ok(pubResult.data.toString().includes('prescription'), 'Public: relay sees "prescription"')
  t.ok(pubResult.data.toString().includes('4750'), 'Public: relay sees amount')

  // Local-first
  t.comment('  ║  LOCAL-FIRST: Relay sees: [nothing — data on device]')
  t.is(localResult.data, null, 'Local-first: relay gets nothing')

  // P2P-only
  t.comment('  ║  P2P-ONLY:   Relay sees: [nothing — not involved]')
  t.is(p2pResult.data, null, 'P2P-only: relay gets nothing')

  t.comment('  ╚═══════════════════════════════════════════════════════╝')

  // Both private tiers stored locally
  const localTx = await pmLocal.retrieveJSON('tx')
  const p2pTx = await pmP2P.retrieveJSON('tx')
  t.is(localTx.memo, 'prescription', 'Local-first: user can read own data')
  t.is(p2pTx.memo, 'prescription', 'P2P-only: user can read own data')

  pmPub.destroy()
  pmLocal.destroy()
  pmP2P.destroy()
})

// ── Blind Mode Encryption ───────────────────────────────────

test('blind mode: encryptForTransit produces opaque blobs', async (t) => {
  const dir = tmpPath('blind')
  const pm = new PrivacyManager({
    appName: 'blind-wallet',
    privacyTier: 'local-first'
  }, dir)
  await pm.init()

  const tx = { from: 'alice', to: 'bob', amount: 100000, memo: 'secret payment' }
  const sealed = pm.encryptForTransit(tx)

  t.ok(b4a.isBuffer(sealed), 'Sealed is a buffer')
  t.ok(sealed.length > 0, 'Sealed has content')
  t.ok(!sealed.toString().includes('alice'), 'Sealed: no "alice"')
  t.ok(!sealed.toString().includes('secret payment'), 'Sealed: no "secret payment"')

  // Decrypt on the other side
  const decrypted = pm.decryptFromTransit(sealed)
  const parsed = JSON.parse(decrypted.toString())
  t.is(parsed.from, 'alice', 'Decrypted: sender recovered')
  t.is(parsed.amount, 100000, 'Decrypted: amount recovered')

  pm.destroy()
})

test('blind mode: drive encryption key is tier-dependent', async (t) => {
  // Public: no encryption key
  const dirPub = tmpPath('blind-pub')
  const pmPub = new PrivacyManager({ appName: 'pub', privacyTier: 'public' }, dirPub)
  await pmPub.init()
  t.is(pmPub.driveEncryptionKey(), null, 'Public: no drive encryption key')

  // Local-first: has encryption key
  const dirLocal = tmpPath('blind-local')
  const pmLocal = new PrivacyManager({ appName: 'local', privacyTier: 'local-first' }, dirLocal)
  await pmLocal.init()
  const key = pmLocal.driveEncryptionKey()
  t.ok(key, 'Local-first: has drive encryption key')
  t.is(key.length, 32, 'Key is 32 bytes')

  // P2P-only: has encryption key
  const dirP2P = tmpPath('blind-p2p')
  const pmP2P = new PrivacyManager({ appName: 'p2p', privacyTier: 'p2p-only' }, dirP2P)
  await pmP2P.init()
  t.ok(pmP2P.driveEncryptionKey(), 'P2P-only: has drive encryption key')

  pmPub.destroy()
  pmLocal.destroy()
  pmP2P.destroy()
})

// ── Edge Cases ──────────────────────────────────────────────

test('invalid tier rejected', async (t) => {
  try {
    new PrivacyManager({ appName: 'test', privacyTier: 'maximum-stealth' }, '/tmp/test')
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('Invalid privacy tier'), 'Invalid tier rejected')
  }
})

test('operations before init() throw', async (t) => {
  const pm = new PrivacyManager({ appName: 'test', privacyTier: 'local-first' }, '/tmp/test')
  try {
    await pm.store('key', 'value')
    t.fail('Should have thrown')
  } catch (err) {
    t.ok(err.message.includes('not initialized'), 'Store before init rejected')
  }
})
