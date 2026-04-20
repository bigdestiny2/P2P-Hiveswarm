import test from 'brittle'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { ManifestStore } from 'p2p-hiverelay/core/manifest-store.js'
import { createSeedingManifest } from 'p2p-hiverelay/core/seeding-manifest.js'

function makeKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function validHex (n) {
  return Array.from({ length: n }).map((_, i) => (i % 16).toString(16)).join('')
}

const DRIVE_KEY = validHex(64)

async function setup (t, storeOpts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hr-manifest-store-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  return new ManifestStore({ storagePath: join(dir, 'manifests.json'), ...storeOpts })
}

function mkManifest (keyPair, opts = {}) {
  return createSeedingManifest({
    keyPair,
    relays: [{ url: 'hyperswarm://a', role: 'primary' }],
    drives: [{ driveKey: DRIVE_KEY }],
    timestamp: opts.timestamp
  })
}

test('put + get stores and retrieves a valid manifest', async (t) => {
  const store = await setup(t)
  const kp = makeKeyPair()
  const m = mkManifest(kp)
  const result = store.put(m)
  t.ok(result.ok)
  t.is(result.replaced, false)
  const pubkeyHex = b4a.toString(kp.publicKey, 'hex')
  const fetched = store.get(pubkeyHex)
  t.is(fetched.signature, m.signature)
})

test('put rejects unsigned / invalid manifests', async (t) => {
  const store = await setup(t)
  const result = store.put({ type: 'not/the/right/type' })
  t.absent(result.ok)
  t.is(store.size(), 0)
})

test('put replaces older manifest with newer one', async (t) => {
  const store = await setup(t)
  const kp = makeKeyPair()
  const older = mkManifest(kp, { timestamp: 1000 })
  const newer = mkManifest(kp, { timestamp: 2000 })

  t.is(store.put(older).ok, true)
  const r = store.put(newer)
  t.ok(r.ok)
  t.is(r.replaced, true)
  t.is(store.get(b4a.toString(kp.publicKey, 'hex')).timestamp, 2000)
})

test('put rejects older manifest when newer exists', async (t) => {
  const store = await setup(t)
  const kp = makeKeyPair()
  const newer = mkManifest(kp, { timestamp: 2000 })
  const older = mkManifest(kp, { timestamp: 1000 })

  t.is(store.put(newer).ok, true)
  const r = store.put(older)
  t.absent(r.ok)
  t.ok(/stale/.test(r.reason))
  // Still holds newer.
  t.is(store.get(b4a.toString(kp.publicKey, 'hex')).timestamp, 2000)
})

test('get is case-insensitive on pubkey', async (t) => {
  const store = await setup(t)
  const kp = makeKeyPair()
  const m = mkManifest(kp)
  store.put(m)
  const hex = b4a.toString(kp.publicKey, 'hex')
  t.ok(store.get(hex.toUpperCase()))
  t.ok(store.get(hex.toLowerCase()))
})

test('save + load persists manifests across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-manifest-store-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'manifests.json')

  const a = new ManifestStore({ storagePath: path })
  const kp = makeKeyPair()
  const m = mkManifest(kp)
  a.put(m)
  await a.save()

  const b = new ManifestStore({ storagePath: path })
  await b.load()
  t.is(b.size(), 1)
  t.is(b.get(b4a.toString(kp.publicKey, 'hex')).signature, m.signature)
})

test('load drops invalid manifests but keeps valid ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-manifest-store-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'manifests.json')

  const kp = makeKeyPair()
  const good = mkManifest(kp)
  // Seed the file manually with a mix of valid/invalid entries.
  const { writeFile } = await import('fs/promises')
  await writeFile(path, JSON.stringify({
    version: 1,
    entries: [
      { manifest: good, storedAt: Date.now() },
      { manifest: { type: 'garbage', version: 1 }, storedAt: Date.now() },
      { manifest: null, storedAt: 0 }
    ]
  }), 'utf8')

  const store = new ManifestStore({ storagePath: path })
  let rejected = 0
  store.on('load-rejected', () => { rejected++ })
  await store.load()
  t.is(store.size(), 1, 'only the valid manifest survived')
  t.ok(rejected >= 1, 'at least one rejection was emitted')
})

test('enforces maxAuthors cap via oldest-first eviction', async (t) => {
  const store = await setup(t, { maxAuthors: 2 })
  const kpA = makeKeyPair()
  const kpB = makeKeyPair()
  const kpC = makeKeyPair()

  const mA = mkManifest(kpA)
  const mB = mkManifest(kpB)
  const mC = mkManifest(kpC)

  let evicted = 0
  store.on('evicted', () => { evicted++ })

  store.put(mA)
  // Stamp storedAt spread out so ordering is deterministic.
  await new Promise(r => setTimeout(r, 5))
  store.put(mB)
  await new Promise(r => setTimeout(r, 5))
  store.put(mC)

  t.is(store.size(), 2)
  t.is(evicted, 1, 'oldest evicted')
  // A was oldest, so A should be gone.
  t.absent(store.get(b4a.toString(kpA.publicKey, 'hex')))
  t.ok(store.get(b4a.toString(kpB.publicKey, 'hex')))
  t.ok(store.get(b4a.toString(kpC.publicKey, 'hex')))
})

test('delete removes a manifest', async (t) => {
  const store = await setup(t)
  const kp = makeKeyPair()
  store.put(mkManifest(kp))
  const hex = b4a.toString(kp.publicKey, 'hex')
  t.ok(store.delete(hex))
  t.absent(store.get(hex))
})

test('list returns snapshot of all manifests', async (t) => {
  const store = await setup(t)
  const kpA = makeKeyPair()
  const kpB = makeKeyPair()
  store.put(mkManifest(kpA))
  store.put(mkManifest(kpB))

  const items = store.list()
  t.is(items.length, 2)
  for (const item of items) {
    t.ok(item.pubkey)
    t.ok(item.manifest)
    t.is(typeof item.storedAt, 'number')
  }
})

test('load is no-op when no storagePath (runtime-only store)', async (t) => {
  const store = new ManifestStore({})
  await store.load()
  t.is(store.size(), 0)
  await store.save() // no-op
  t.pass('save + load are silent when storagePath is null')
})
