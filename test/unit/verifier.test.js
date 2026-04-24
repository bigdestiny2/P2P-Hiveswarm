import test from 'brittle'
import { verifyRelays, compareDrive } from 'p2p-hiverelay-verifier'

// We use an injected fetch so we never hit real network. The
// verifier's contract is "same input bytes → same verdict" — perfect
// for deterministic unit testing.

function mockFetch (responses) {
  return async (url) => {
    const handler = responses[url]
    if (!handler) {
      return { ok: false, status: 404, text: async () => '' }
    }
    if (typeof handler === 'function') return handler(url)
    return {
      ok: handler.ok !== false,
      status: handler.status || 200,
      text: async () => JSON.stringify(handler.body || {})
    }
  }
}

const RELAY_A = 'https://relay-a.example.com'
const RELAY_B = 'https://relay-b.example.com'

const sameCapabilityDoc = {
  schemaVersion: 1,
  software: 'https://github.com/bigdestiny2/p2p-hiverelay',
  version: '0.6.0',
  features: ['capability-doc', 'federation']
}

test('verifyRelays requires at least 2 URLs', async (t) => {
  try {
    await verifyRelays([RELAY_A], { fetch: mockFetch({}) })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('at least 2'))
  }
})

test('verifyRelays returns AGREE when both relays serve identical caps + catalogs', async (t) => {
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_B + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_A + '/catalog.json']: { body: { entries: [] } },
    [RELAY_B + '/catalog.json']: { body: { entries: [] } }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  t.is(report.verdict, 'agree')
  t.is(report.divergenceCount, 0)
  t.is(report.fetchErrors.length, 0)
  t.ok(report.capabilitiesOK)
  t.ok(report.catalogsOK)
})

test('verifyRelays flags schemaVersion divergence', async (t) => {
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: { body: { ...sameCapabilityDoc, schemaVersion: 1 } },
    [RELAY_B + '/.well-known/hiverelay.json']: { body: { ...sameCapabilityDoc, schemaVersion: 2 } },
    [RELAY_A + '/catalog.json']: { body: { entries: [] } },
    [RELAY_B + '/catalog.json']: { body: { entries: [] } }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  t.is(report.verdict, 'diverge')
  const cap = report.divergences.find(d => d.field === 'schemaVersion')
  t.ok(cap, 'schemaVersion divergence reported')
  t.is(cap.valueA, 1)
  t.is(cap.valueB, 2)
})

test('verifyRelays flags catalog entry divergence', async (t) => {
  const sharedAppKey = 'a'.repeat(64)
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_B + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_A + '/catalog.json']: {
      body: { entries: [{ appKey: sharedAppKey, type: 'app', publisherPubkey: 'pubA', version: '1.0.0' }] }
    },
    [RELAY_B + '/catalog.json']: {
      body: { entries: [{ appKey: sharedAppKey, type: 'app', publisherPubkey: 'pubA', version: '2.0.0' }] }
    }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  t.is(report.verdict, 'diverge')
  const div = report.divergences.find(d => d.category === 'catalog-entry')
  t.ok(div)
  t.is(div.appKey, sharedAppKey)
  t.alike(div.divergentFields, ['version'])
})

test('verifyRelays handles partial relay failures gracefully', async (t) => {
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_B + '/.well-known/hiverelay.json']: { ok: false, status: 503 },
    [RELAY_A + '/catalog.json']: { body: { entries: [] } },
    [RELAY_B + '/catalog.json']: { ok: false, status: 503 }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  t.absent(report.capabilitiesOK)
  t.absent(report.catalogsOK)
  t.is(report.fetchErrors.length, 2)
  t.is(report.fetchErrors[0].relay, RELAY_B)
})

test('verifyRelays does NOT flag entries unique to one relay', async (t) => {
  // Federation is selective — one relay may carry an app another doesn't.
  // That's not divergence, that's design.
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_B + '/.well-known/hiverelay.json']: { body: sameCapabilityDoc },
    [RELAY_A + '/catalog.json']: { body: { entries: [{ appKey: 'a'.repeat(64), type: 'app', version: '1.0.0' }] } },
    [RELAY_B + '/catalog.json']: { body: { entries: [{ appKey: 'b'.repeat(64), type: 'app', version: '1.0.0' }] } }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  t.is(report.verdict, 'agree', 'unique-to-one-relay entries are not divergence')
})

test('compareDrive validates input', async (t) => {
  try {
    await compareDrive('not-hex', [RELAY_A, RELAY_B], { fetch: async () => ({ ok: true, text: async () => '{}' }) })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('64 hex chars'))
  }
})

test('compareDrive returns AGREE when both views match', async (t) => {
  const drive = 'a'.repeat(64)
  const driveInfo = { length: 100, version: 1, contentHash: 'abc123' }
  const fetch = mockFetch({
    [RELAY_A + '/v1/hyper/' + drive + '/info']: { body: driveInfo },
    [RELAY_B + '/v1/hyper/' + drive + '/info']: { body: driveInfo }
  })
  const report = await compareDrive(drive, [RELAY_A, RELAY_B], { fetch })
  t.is(report.agreement, 'agree')
})

test('compareDrive flags divergent length/version/contentHash', async (t) => {
  const drive = 'a'.repeat(64)
  const fetch = mockFetch({
    [RELAY_A + '/v1/hyper/' + drive + '/info']: { body: { length: 100, version: 1, contentHash: 'abc123' } },
    [RELAY_B + '/v1/hyper/' + drive + '/info']: { body: { length: 99, version: 1, contentHash: 'def456' } }
  })
  const report = await compareDrive(drive, [RELAY_A, RELAY_B], { fetch })
  t.is(report.agreement, 'diverge')
  t.is(report.divergentFrom.length, 1)
  t.is(report.divergentFrom[0].relay, RELAY_B)
})

test('compareDrive returns insufficient-data when only one relay responds', async (t) => {
  const drive = 'a'.repeat(64)
  const fetch = mockFetch({
    [RELAY_A + '/v1/hyper/' + drive + '/info']: { body: { length: 100, version: 1 } },
    [RELAY_B + '/v1/hyper/' + drive + '/info']: { ok: false, status: 503 }
  })
  const report = await compareDrive(drive, [RELAY_A, RELAY_B], { fetch })
  t.is(report.agreement, 'insufficient-data')
})

test('software-URL divergence is reported with severity=info (different impls allowed)', async (t) => {
  const fetch = mockFetch({
    [RELAY_A + '/.well-known/hiverelay.json']: {
      body: { ...sameCapabilityDoc, software: 'https://github.com/bigdestiny2/p2p-hiverelay' }
    },
    [RELAY_B + '/.well-known/hiverelay.json']: {
      body: { ...sameCapabilityDoc, software: 'https://github.com/some-other/impl' }
    },
    [RELAY_A + '/catalog.json']: { body: { entries: [] } },
    [RELAY_B + '/catalog.json']: { body: { entries: [] } }
  })
  const report = await verifyRelays([RELAY_A, RELAY_B], { fetch })
  const sw = report.divergences.find(d => d.field === 'software')
  t.ok(sw)
  t.is(sw.severity, 'info')
})
