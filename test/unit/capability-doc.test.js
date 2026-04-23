import test from 'brittle'
import { buildCapabilityDoc, CAPABILITY_DOC_SCHEMA_VERSION } from 'p2p-hiverelay/core/capability-doc.js'

// We test buildCapabilityDoc purely — no swarm, no HTTP server, no
// filesystem. The builder accepts a partial relay-shaped object, so every
// test constructs just enough to exercise one branch.

test('builds with no relay at all (safe default)', async (t) => {
  const doc = buildCapabilityDoc({})
  t.is(doc.schemaVersion, CAPABILITY_DOC_SCHEMA_VERSION)
  t.is(doc.name, null)
  t.is(doc.pubkey, null)
  t.is(doc.software, 'https://github.com/bigdestiny2/p2p-hiverelay')
  t.ok(Array.isArray(doc.supported_transports))
  t.ok(Array.isArray(doc.features))
  t.ok(doc.features.includes('capability-doc'), 'always advertises capability-doc feature')
  t.is(doc.limitation.accept_mode, 'review', 'default mode is review when no config')
  t.is(doc.federation, null)
  t.is(doc.catalog, null)
  t.is(doc.fees, null)
})

test('extracts accept_mode + limits from relay config', async (t) => {
  const relay = {
    config: {
      acceptMode: 'allowlist',
      maxPendingRequests: 5000,
      maxConnections: 256,
      maxStorageBytes: 50 * 1024 * 1024 * 1024,
      maxRelayBandwidthMbps: 100,
      regions: ['eu-west-1']
    }
  }
  const doc = buildCapabilityDoc({ relay, version: '0.5.1' })
  t.is(doc.version, '0.5.1')
  t.is(doc.region, 'eu-west-1')
  t.is(doc.limitation.accept_mode, 'allowlist')
  t.is(doc.limitation.max_pending_requests, 5000)
  t.is(doc.limitation.max_connections, 256)
  t.is(doc.limitation.max_storage_bytes, 50 * 1024 * 1024 * 1024)
  t.is(doc.limitation.max_relay_bandwidth_mbps, 100)
})

test('detects transports from runtime state', async (t) => {
  const relay = {
    config: {
      discovery: { dht: true, mdns: true }
    },
    dhtRelayWs: { running: true },
    torTransport: { running: true },
    holesailTransport: {}
  }
  const doc = buildCapabilityDoc({ relay })
  t.ok(doc.supported_transports.includes('hyperswarm'))
  t.ok(doc.supported_transports.includes('mdns'))
  t.ok(doc.supported_transports.includes('dht-relay-ws'))
  t.ok(doc.supported_transports.includes('tor'))
  t.ok(doc.supported_transports.includes('holesail'))
})

test('features list is sorted and reflects wired subsystems', async (t) => {
  const relay = {
    config: {},
    federation: {},
    _checkDelegation: () => {},
    _revokedCertSignatures: new Map(),
    seedingRegistry: {},
    reputation: {}
  }
  const doc = buildCapabilityDoc({ relay })
  const sorted = [...doc.features].sort()
  t.alike(doc.features, sorted, 'features sorted alphabetically')
  t.ok(doc.features.includes('federation'))
  t.ok(doc.features.includes('delegation-certs'))
  t.ok(doc.features.includes('delegation-revocation'))
  t.ok(doc.features.includes('seeding-registry'))
  t.ok(doc.features.includes('reputation'))
  t.ok(doc.features.includes('capability-doc'))
})

test('federation snapshot is summarized, not leaked', async (t) => {
  const relay = {
    config: {},
    federation: {
      snapshot: () => ({
        followed: [{ url: 'http://a' }, { url: 'http://b' }],
        mirrored: [{ url: 'http://c' }],
        republished: []
      })
    }
  }
  const doc = buildCapabilityDoc({ relay })
  t.alike(doc.federation, { followed: 2, mirrored: 1, republished: 0 })
})

test('federation snapshot failure is tolerated (null not throw)', async (t) => {
  const relay = {
    config: {},
    federation: {
      snapshot: () => { throw new Error('boom') }
    }
  }
  const doc = buildCapabilityDoc({ relay })
  t.is(doc.federation, null)
})

test('catalog counts are computed from appRegistry.catalog()', async (t) => {
  const relay = {
    config: {},
    appRegistry: {
      catalog: () => [
        { type: 'app' },
        { type: 'app' },
        { type: 'drive' },
        { type: 'drive', parentKey: 'pk1' },
        { type: 'dataset' },
        { type: 'media' }
      ]
    }
  }
  const doc = buildCapabilityDoc({ relay })
  t.is(doc.catalog.total, 6)
  t.is(doc.catalog.apps, 2)
  t.is(doc.catalog.drives, 1)
  t.is(doc.catalog.resources, 1)
  t.is(doc.catalog.datasets, 1)
  t.is(doc.catalog.media, 1)
})

test('payment_required flips when paymentProvider is set', async (t) => {
  const docWithout = buildCapabilityDoc({ relay: { config: {} } })
  t.is(docWithout.limitation.payment_required, false)
  const docWith = buildCapabilityDoc({
    relay: {
      config: {},
      paymentManager: { paymentProvider: {} }
    }
  })
  t.is(docWith.limitation.payment_required, true)
})

test('operator metadata flows through when provided', async (t) => {
  const doc = buildCapabilityDoc({
    relay: { config: {} },
    name: 'HiveRelay NYC',
    description: 'Public relay for NYC users',
    contact: 'mailto:admin@example.com',
    termsOfService: 'https://example.com/tos',
    icon: 'https://example.com/icon.png'
  })
  t.is(doc.name, 'HiveRelay NYC')
  t.is(doc.description, 'Public relay for NYC users')
  t.is(doc.contact, 'mailto:admin@example.com')
  t.is(doc.terms_of_service, 'https://example.com/tos')
  t.is(doc.icon, 'https://example.com/icon.png')
})

test('explicit runtime override respected', async (t) => {
  const doc = buildCapabilityDoc({ relay: { config: {} }, runtime: 'bare' })
  t.is(doc.runtime, 'bare')
})
