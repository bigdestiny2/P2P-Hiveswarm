import test from 'brittle'
import { ArbitrationService } from '../../core/services/builtin/arbitration-service.js'

function mockNode (opts = {}) {
  const slashed = []
  const published = []
  const challengeRecords = []

  const records = {
    eligible1: { score: 200, totalChallenges: 100, passedChallenges: 99, failedChallenges: 1, avgLatencyMs: 500 },
    eligible2: { score: 150, totalChallenges: 80, passedChallenges: 78, failedChallenges: 2, avgLatencyMs: 600 },
    eligible3: { score: 120, totalChallenges: 60, passedChallenges: 58, failedChallenges: 2, avgLatencyMs: 700 },
    ineligible: { score: 10, totalChallenges: 5, passedChallenges: 3, failedChallenges: 2, avgLatencyMs: 4000 },
    ...opts.records
  }

  return {
    reputation: {
      getRecord: (pubkey) => records[pubkey] || null,
      getReliability: (pubkey) => {
        const r = records[pubkey]
        return r ? r.passedChallenges / r.totalChallenges : 0
      },
      recordChallenge: (pubkey, passed, latency) => {
        challengeRecords.push({ pubkey, passed, latency })
      }
    },
    paymentManager: {
      slash: (pubkey, amount, reason) => { slashed.push({ pubkey, amount, reason }) }
    },
    router: {
      pubsub: { publish: (topic, data) => { published.push({ topic, data }) } }
    },
    _slashed: slashed,
    _published: published,
    _challengeRecords: challengeRecords
  }
}

function createService (opts = {}) {
  const svc = new ArbitrationService()
  const node = mockNode(opts)
  svc.start({ node })
  return { svc, node }
}

test('ArbitrationService - manifest', async (t) => {
  const svc = new ArbitrationService()
  const m = svc.manifest()
  t.is(m.name, 'arbitration')
  t.ok(m.capabilities.includes('submit'))
  t.ok(m.capabilities.includes('vote'))
  t.ok(m.capabilities.includes('evidence'))
})

test('ArbitrationService - submit dispute', async (t) => {
  const { svc } = createService()
  const d = await svc.submit({
    type: 'sla-violation',
    respondent: 'relayA',
    penalty: 5000
  }, { remotePubkey: 'claimantX' })

  t.is(d.type, 'sla-violation')
  t.is(d.claimant, 'claimantX')
  t.is(d.respondent, 'relayA')
  t.is(d.status, 'open')
  t.is(d.penalty, 5000)
  t.ok(d.id.length === 32)
})

test('ArbitrationService - submit validates type', async (t) => {
  const { svc } = createService()
  try {
    await svc.submit({ type: 'invalid', respondent: 'x' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('ARBITRATION_INVALID_TYPE')) }
})

test('ArbitrationService - submit rejects self-dispute', async (t) => {
  const { svc } = createService()
  try {
    await svc.submit({ type: 'proof-failure', respondent: 'self' }, { remotePubkey: 'self' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('ARBITRATION_SELF_DISPUTE')) }
})

test('ArbitrationService - vote by eligible arbitrator', async (t) => {
  const { svc } = createService()
  const d = await svc.submit({ type: 'proof-failure', respondent: 'relayA', penalty: 1000 }, { remotePubkey: 'claimantX' })

  const updated = await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible1' })
  t.is(updated.status, 'voting')
  t.is(updated.votes.length, 1)
  t.is(updated.votes[0].voter, 'eligible1')
  t.is(updated.votes[0].verdict, 'claimant')
})

test('ArbitrationService - vote rejects ineligible arbitrator', async (t) => {
  const { svc } = createService()
  const d = await svc.submit({ type: 'proof-failure', respondent: 'relayA' }, { remotePubkey: 'claimantX' })

  try {
    await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'ineligible' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('ARBITRATOR_INELIGIBLE')) }
})

test('ArbitrationService - vote rejects conflict of interest', async (t) => {
  const { svc } = createService()
  const d = await svc.submit({ type: 'proof-failure', respondent: 'eligible1' }, { remotePubkey: 'claimantX' })

  try {
    await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible1' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('ARBITRATOR_INELIGIBLE')) }
})

test('ArbitrationService - vote rejects duplicate vote', async (t) => {
  const { svc } = createService()
  const d = await svc.submit({ type: 'proof-failure', respondent: 'relayA' }, { remotePubkey: 'claimantX' })

  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible1' })
  try {
    await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible1' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('ARBITRATION_ALREADY_VOTED')) }
})

test('ArbitrationService - resolves when minVotes reached (claimant wins)', async (t) => {
  const { svc, node } = createService()
  const d = await svc.submit({ type: 'sla-violation', respondent: 'relayA', penalty: 5000, minVotes: 3 }, { remotePubkey: 'claimantX' })

  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible1' })
  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible2' })
  const result = await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible3' })

  t.is(result.status, 'resolved')
  t.is(result.verdict, 'claimant')
  t.ok(result.resolvedAt)

  // Respondent slashed
  t.is(node._slashed.length, 1)
  t.is(node._slashed[0].amount, 5000)
  t.is(node._slashed[0].pubkey, 'relayA')

  // Winner voters get +10 (passed=true), loser voter gets -20 (passed=false)
  const winners = node._challengeRecords.filter(r => r.passed === true)
  const losers = node._challengeRecords.filter(r => r.passed === false)
  t.is(winners.length, 2) // eligible1, eligible2
  t.is(losers.length, 1) // eligible3
})

test('ArbitrationService - resolves respondent wins (no slash)', async (t) => {
  const { svc, node } = createService()
  const d = await svc.submit({ type: 'receipt-dispute', respondent: 'relayA', penalty: 3000, minVotes: 3 }, { remotePubkey: 'claimantX' })

  await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible1' })
  await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible2' })
  const result = await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible3' })

  t.is(result.verdict, 'respondent')
  t.is(node._slashed.length, 0) // No slash
})

test('ArbitrationService - vote rejects on resolved dispute', async (t) => {
  const { svc } = createService()
  // minVotes is enforced at MIN_VOTES_FLOOR=3 (security fix) — need 3 votes to resolve
  const d = await svc.submit({ type: 'proof-failure', respondent: 'relayA', minVotes: 3 }, { remotePubkey: 'claimantX' })
  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible1' })
  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible2' })
  await svc.vote({ id: d.id, verdict: 'claimant' }, { remotePubkey: 'eligible3' })

  try {
    await svc.vote({ id: d.id, verdict: 'respondent' }, { remotePubkey: 'eligible4' })
    t.fail()
  } catch (e) { t.ok(e.message.includes('DISPUTE_ALREADY_RESOLVED')) }
})

test('ArbitrationService - get and list', async (t) => {
  const { svc } = createService()
  const d1 = await svc.submit({ type: 'sla-violation', respondent: 'r1' }, { remotePubkey: 'c1' })
  const d2 = await svc.submit({ type: 'proof-failure', respondent: 'r2' }, { remotePubkey: 'c2' })

  const got = await svc.get({ id: d1.id })
  t.is(got.id, d1.id)

  const all = await svc.list()
  t.is(all.length, 2)

  const filtered = await svc.list({ type: 'proof-failure' })
  t.is(filtered.length, 1)
  t.is(filtered[0].id, d2.id)
})

test('ArbitrationService - get not found', async (t) => {
  const { svc } = createService()
  try { await svc.get({ id: 'nope' }); t.fail() } catch (e) { t.ok(e.message.includes('DISPUTE_NOT_FOUND')) }
})

test('ArbitrationService - pubsub events emitted', async (t) => {
  const { svc, node } = createService()
  await svc.submit({ type: 'proof-failure', respondent: 'relayA', minVotes: 3, penalty: 100 }, { remotePubkey: 'claimantX' })

  t.ok(node._published.some(p => p.topic === 'arbitration/submitted'))

  const disputes = await svc.list()
  await svc.vote({ id: disputes[0].id, verdict: 'claimant' }, { remotePubkey: 'eligible1' })
  await svc.vote({ id: disputes[0].id, verdict: 'claimant' }, { remotePubkey: 'eligible2' })
  await svc.vote({ id: disputes[0].id, verdict: 'claimant' }, { remotePubkey: 'eligible3' })

  t.ok(node._published.some(p => p.topic === 'arbitration/resolved'))
})
