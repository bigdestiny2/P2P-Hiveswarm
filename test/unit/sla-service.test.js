import test from 'brittle'
import { SLAService } from '../../core/services/builtin/sla-service.js'

function mockNode (opts = {}) {
  const slashed = []
  const published = []
  return {
    _proofOfRelay: {
      scores: opts.scores || new Map()
    },
    reputation: {
      getRecord: (pubkey) => opts.reputationRecords?.[pubkey] || null
    },
    paymentManager: {
      slash: (pubkey, amount, reason) => { slashed.push({ pubkey, amount, reason }) }
    },
    router: {
      pubsub: {
        publish: (topic, data) => { published.push({ topic, data }) }
      }
    },
    _slashed: slashed,
    _published: published
  }
}

function createService (nodeOpts = {}) {
  const svc = new SLAService()
  const node = mockNode(nodeOpts)
  svc.start({ node })
  // Clear the enforcement interval for tests (we'll call manually)
  clearInterval(svc._checkInterval)
  svc._checkInterval = null
  return { svc, node }
}

const baseParams = {
  appKey: 'a'.repeat(64),
  relayPubkey: 'b'.repeat(64),
  guarantees: { minReliability: 0.99, maxLatencyMs: 2000 },
  collateral: 10000,
  premiumRate: 3.0,
  duration: 30 * 24 * 60 * 60 * 1000
}

test('SLAService - manifest', async (t) => {
  const svc = new SLAService()
  const m = svc.manifest()
  t.is(m.name, 'sla')
  t.ok(m.capabilities.includes('create'))
  t.ok(m.capabilities.includes('check'))
})

test('SLAService - create contract', async (t) => {
  const { svc } = createService()
  const c = await svc.create(baseParams)
  t.is(c.appKey, baseParams.appKey)
  t.is(c.status, 'active')
  t.is(c.collateral, 10000)
  t.is(c.collateralRemaining, 10000)
  t.ok(c.id.length === 32)
  t.ok(c.violations.length === 0)
})

test('SLAService - create validates required fields', async (t) => {
  const { svc } = createService()
  try { await svc.create({}); t.fail() } catch (e) { t.ok(e.message.includes('SLA_MISSING')) }
  try { await svc.create({ appKey: 'a', relayPubkey: 'b' }); t.fail() } catch (e) { t.ok(e.message.includes('SLA_MISSING')) }
  try { await svc.create({ ...baseParams, collateral: 0 }); t.fail() } catch (e) { t.ok(e.message.includes('SLA_INVALID')) }
})

test('SLAService - get and list', async (t) => {
  const { svc } = createService()
  const c = await svc.create(baseParams)

  const got = await svc.get({ id: c.id })
  t.is(got.id, c.id)

  const list = await svc.list()
  t.is(list.length, 1)

  const filtered = await svc.list({ status: 'terminated' })
  t.is(filtered.length, 0)
})

test('SLAService - get not found', async (t) => {
  const { svc } = createService()
  try { await svc.get({ id: 'nonexistent' }); t.fail() } catch (e) { t.ok(e.message.includes('SLA_NOT_FOUND')) }
})

test('SLAService - terminate', async (t) => {
  const { svc, node } = createService()
  const c = await svc.create(baseParams)

  await svc.terminate({ id: c.id, slashRemaining: true })
  const got = await svc.get({ id: c.id })
  t.is(got.status, 'terminated')
  t.is(got.collateralRemaining, 0)
  t.is(node._slashed.length, 1)
  t.is(node._slashed[0].amount, 10000)
})

test('SLAService - check detects reliability violation', async (t) => {
  const scores = new Map()
  scores.set('b'.repeat(64), { challenges: 100, passes: 90, fails: 10, avgLatencyMs: 500 })
  const { svc, node } = createService({ scores })
  const c = await svc.create(baseParams)

  const result = await svc.check({ id: c.id })
  t.is(result.passed, false)
  t.ok(result.violations.some(v => v.type === 'reliability'))
  t.is(node._slashed.length, 1) // Penalty applied
})

test('SLAService - check detects latency violation', async (t) => {
  const scores = new Map()
  scores.set('b'.repeat(64), { challenges: 100, passes: 100, fails: 0, avgLatencyMs: 3000 })
  const { svc, node } = createService({ scores })
  const c = await svc.create(baseParams)

  const result = await svc.check({ id: c.id })
  t.is(result.passed, false)
  t.ok(result.violations.some(v => v.type === 'latency'))
})

test('SLAService - check passes when guarantees met', async (t) => {
  const scores = new Map()
  scores.set('b'.repeat(64), { challenges: 100, passes: 100, fails: 0, avgLatencyMs: 500 })
  const { svc } = createService({ scores })
  const c = await svc.create(baseParams)

  const result = await svc.check({ id: c.id })
  t.is(result.passed, true)
  t.is(result.violations.length, 0)
})

test('SLAService - auto-terminate after 3 violations', async (t) => {
  const scores = new Map()
  scores.set('b'.repeat(64), { challenges: 100, passes: 50, fails: 50, avgLatencyMs: 5000 })
  const { svc, node } = createService({ scores })
  const c = await svc.create(baseParams)

  // Each check produces 2 violations (reliability + latency)
  await svc.check({ id: c.id }) // 2 violations
  const got1 = await svc.get({ id: c.id })
  t.is(got1.status, 'active') // Still active at 2

  await svc.check({ id: c.id }) // 4 violations total, exceeds MAX_VIOLATIONS=3
  const got2 = await svc.get({ id: c.id })
  t.is(got2.status, 'violated')
  t.is(got2.collateralRemaining, 0)
})

test('SLAService - violations returns array', async (t) => {
  const scores = new Map()
  scores.set('b'.repeat(64), { challenges: 100, passes: 90, fails: 10, avgLatencyMs: 500 })
  const { svc } = createService({ scores })
  const c = await svc.create(baseParams)
  await svc.check({ id: c.id })

  const violations = await svc.violations({ id: c.id })
  t.ok(violations.length > 0)
  t.ok(violations[0].timestamp)
  t.ok(violations[0].penalty >= 0)
})

test('SLAService - stats', async (t) => {
  const { svc } = createService()
  await svc.create(baseParams)
  await svc.create({ ...baseParams, collateral: 5000 })

  const s = await svc.stats()
  t.is(s.total, 2)
  t.is(s.active, 2)
  t.is(s.totalCollateral, 15000)
})

test('SLAService - enforceAll expires old contracts', async (t) => {
  const { svc } = createService()
  const c = await svc.create({ ...baseParams, duration: 1 }) // 1ms duration

  // Wait for expiry
  await new Promise(resolve => setTimeout(resolve, 10))
  svc._enforceAll()

  const got = await svc.get({ id: c.id })
  t.is(got.status, 'expired')
})
