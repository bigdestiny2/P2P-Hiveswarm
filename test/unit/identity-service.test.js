import test from 'brittle'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { IdentityService } from '../../core/services/builtin/identity-service.js'

function mockIPL (opts = {}) {
  return {
    resolveIdentity: opts.resolveIdentity || (async () => null),
    developers: {
      getProfile: opts.getProfile || (async () => null)
    },
    attestation: {
      getDeveloperApps: opts.getDeveloperApps || (() => [])
    }
  }
}

function mockNode (opts = {}) {
  const pk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const sk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(pk, sk)

  return {
    publicKey: opts.noKey ? null : pk,
    keyPair: opts.noKey ? null : { publicKey: pk, secretKey: sk },
    config: { name: opts.name || 'test-node' },
    mode: opts.mode || 'public',
    accessControl: opts.accessControl || null,
    listDevices: opts.listDevices || (() => []),
    connections: opts.connections || [],
    identity: opts.identity || null
  }
}

async function createService (opts = {}) {
  const svc = new IdentityService()
  const node = mockNode(opts)
  await svc.start({ node })
  return { svc, node }
}

test('IdentityService - manifest', async (t) => {
  const svc = new IdentityService()
  const m = svc.manifest()
  t.is(m.name, 'identity')
  t.is(m.version, '1.1.0')
  t.ok(m.capabilities.includes('whoami'))
  t.ok(m.capabilities.includes('sign'))
  t.ok(m.capabilities.includes('verify'))
  t.ok(m.capabilities.includes('resolve'))
  t.ok(m.capabilities.includes('peers'))
  t.ok(m.capabilities.includes('developer'))
})

test('IdentityService - whoami', async (t) => {
  const { svc, node } = await createService({ name: 'my-relay', mode: 'private' })
  const result = await svc.whoami()
  t.is(result.pubkey, b4a.toString(node.publicKey, 'hex'))
  t.is(result.name, 'my-relay')
  t.is(result.mode, 'private')
})

test('IdentityService - whoami no key', async (t) => {
  const { svc } = await createService({ noKey: true })
  const result = await svc.whoami()
  t.is(result.pubkey, null)
})

test('IdentityService - whoami with IPL developer identity', async (t) => {
  const { svc, node } = await createService({
    identity: mockIPL({
      resolveIdentity: async (appKey) => ({
        developerKey: 'dev123abc',
        profile: { displayName: 'TestDev', about: 'A developer' },
        attestation: { timestamp: 1700000000 }
      })
    })
  })
  const result = await svc.whoami()
  t.is(result.pubkey, b4a.toString(node.publicKey, 'hex'))
  t.ok(result.developer)
  t.is(result.developer.key, 'dev123abc')
  t.is(result.developer.profile.displayName, 'TestDev')
  t.is(result.developer.attestedAt, 1700000000)
})

test('IdentityService - whoami without IPL returns no developer field', async (t) => {
  const { svc } = await createService()
  const result = await svc.whoami()
  t.is(result.developer, undefined)
})

test('IdentityService - sign', async (t) => {
  const { svc } = await createService()
  const result = await svc.sign({ message: 'hello world' })
  t.is(result.message, 'hello world')
  t.is(typeof result.signature, 'string')
  t.is(result.signature.length, sodium.crypto_sign_BYTES * 2) // hex
  t.is(typeof result.pubkey, 'string')
})

test('IdentityService - sign without keypair throws', async (t) => {
  const { svc } = await createService({ noKey: true })
  try {
    await svc.sign({ message: 'test' })
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('NO_KEYPAIR'))
  }
})

test('IdentityService - verify valid signature', async (t) => {
  const { svc } = await createService()
  const signed = await svc.sign({ message: 'verify me' })
  const result = await svc.verify({
    message: 'verify me',
    signature: signed.signature,
    pubkey: signed.pubkey
  })
  t.is(result.valid, true)
})

test('IdentityService - verify tampered signature', async (t) => {
  const { svc } = await createService()
  const signed = await svc.sign({ message: 'original' })
  // Tamper with the signature
  const tampered = 'ff' + signed.signature.slice(2)
  const result = await svc.verify({
    message: 'original',
    signature: tampered,
    pubkey: signed.pubkey
  })
  t.is(result.valid, false)
})

test('IdentityService - verify wrong message', async (t) => {
  const { svc } = await createService()
  const signed = await svc.sign({ message: 'correct' })
  const result = await svc.verify({
    message: 'wrong',
    signature: signed.signature,
    pubkey: signed.pubkey
  })
  t.is(result.valid, false)
})

test('IdentityService - verify wrong pubkey', async (t) => {
  const { svc } = await createService()
  const signed = await svc.sign({ message: 'test' })
  // Generate a different keypair
  const otherPk = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const otherSk = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_keypair(otherPk, otherSk)
  const result = await svc.verify({
    message: 'test',
    signature: signed.signature,
    pubkey: b4a.toString(otherPk, 'hex')
  })
  t.is(result.valid, false)
})

test('IdentityService - verify bad signature length', async (t) => {
  const { svc } = await createService()
  const result = await svc.verify({
    message: 'test',
    signature: 'aabb',
    pubkey: b4a.toString(b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES), 'hex')
  })
  t.is(result.valid, false)
  t.is(result.reason, 'invalid signature length')
})

test('IdentityService - verify bad pubkey length', async (t) => {
  const { svc } = await createService()
  const result = await svc.verify({
    message: 'test',
    signature: b4a.toString(b4a.alloc(sodium.crypto_sign_BYTES), 'hex'),
    pubkey: 'aabb'
  })
  t.is(result.valid, false)
  t.is(result.reason, 'invalid pubkey length')
})

test('IdentityService - resolve via IPL attestation', async (t) => {
  const pubkey = b4a.toString(b4a.alloc(32, 0xbb), 'hex')
  const { svc } = await createService({
    identity: mockIPL({
      resolveIdentity: async (key) => key === pubkey ? {
        developerKey: 'devABC',
        profile: { displayName: 'Alice', name: 'alice' }
      } : null
    })
  })
  const result = await svc.resolve({ pubkey })
  t.is(result.source, 'attestation')
  t.is(result.developerKey, 'devABC')
  t.is(result.name, 'Alice')
  t.is(result.pubkey, pubkey)
})

test('IdentityService - resolve falls back to device allowlist', async (t) => {
  const pubkey = b4a.toString(b4a.alloc(32, 0xaa), 'hex')
  const { svc } = await createService({
    identity: mockIPL(), // IPL returns null
    accessControl: true,
    listDevices: () => [
      { pubkey, name: 'my-phone', addedAt: Date.now() }
    ]
  })
  const result = await svc.resolve({ pubkey })
  t.is(result.name, 'my-phone')
  t.is(result.source, 'device-allowlist')
})

test('IdentityService - resolve not found', async (t) => {
  const { svc } = await createService({
    identity: mockIPL() // IPL returns null, no allowlist
  })
  const result = await svc.resolve({ pubkey: 'deadbeef' })
  t.is(result.name, null)
  t.is(result.source, 'not-found')
})

test('IdentityService - resolve without IPL uses allowlist', async (t) => {
  const pubkey = b4a.toString(b4a.alloc(32, 0xaa), 'hex')
  const { svc } = await createService({
    accessControl: true,
    listDevices: () => [
      { pubkey, name: 'my-phone', addedAt: Date.now() }
    ]
  })
  const result = await svc.resolve({ pubkey })
  t.is(result.name, 'my-phone')
  t.is(result.source, 'device-allowlist')
})

test('IdentityService - developer lookup', async (t) => {
  const { svc } = await createService({
    identity: mockIPL({
      getProfile: async () => ({ displayName: 'Bob', about: 'Builder' }),
      getDeveloperApps: () => ['app1hex', 'app2hex']
    })
  })
  const result = await svc.developer({ key: 'devXYZ' })
  t.is(result.developerKey, 'devXYZ')
  t.ok(result.profile)
  t.ok(result.apps)
})

test('IdentityService - developer without IPL', async (t) => {
  const { svc } = await createService()
  const result = await svc.developer({ key: 'devXYZ' })
  t.is(result.error, 'Identity protocol not available')
})

test('IdentityService - developer missing key throws', async (t) => {
  const { svc } = await createService({
    identity: mockIPL()
  })
  try {
    await svc.developer({})
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('MISSING_PARAM'))
  }
})

test('IdentityService - peers', async (t) => {
  const { svc } = await createService({
    connections: [
      { remotePubKey: 'aabb', type: 'hyperswarm' },
      { remotePubKey: 'ccdd', type: 'websocket' }
    ]
  })
  const result = await svc.peers()
  t.is(result.length, 2)
  t.is(result[0].pubkey, 'aabb')
  t.is(result[1].type, 'websocket')
})
