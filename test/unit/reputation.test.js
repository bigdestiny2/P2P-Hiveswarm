import test from 'brittle'
import { ReputationSystem } from '../../incentive/reputation/index.js'

test('ReputationSystem - records challenges and computes score', async (t) => {
  const rep = new ReputationSystem()
  const relay = 'abc123'

  rep.recordChallenge(relay, true, 200)
  rep.recordChallenge(relay, true, 300)
  rep.recordChallenge(relay, false, 0)

  const record = rep.getRecord(relay)
  t.is(record.totalChallenges, 3)
  t.is(record.passedChallenges, 2)
  t.is(record.failedChallenges, 1)
  t.ok(record.score >= 0, 'score is non-negative')
  t.is(record.avgLatencyMs, 250)
})

test('ReputationSystem - reliability calculation', async (t) => {
  const rep = new ReputationSystem()
  const relay = 'def456'

  for (let i = 0; i < 8; i++) rep.recordChallenge(relay, true, 100)
  for (let i = 0; i < 2; i++) rep.recordChallenge(relay, false, 0)

  const reliability = rep.getReliability(relay)
  t.is(reliability, 0.8, '80% reliability')
})

test('ReputationSystem - decay reduces scores', async (t) => {
  const rep = new ReputationSystem()
  const relay = 'ghi789'

  rep.recordChallenge(relay, true, 100)
  const before = rep.getScore(relay)

  rep.applyDecay()
  const after = rep.getScore(relay)

  t.ok(after < before, 'score decreased after decay')
})

test('ReputationSystem - leaderboard ranking', async (t) => {
  const rep = new ReputationSystem()

  // Create 3 relays with different scores
  for (let i = 0; i < 15; i++) rep.recordChallenge('relay-a', true, 100)
  for (let i = 0; i < 12; i++) rep.recordChallenge('relay-b', true, 200)
  for (let i = 0; i < 10; i++) rep.recordChallenge('relay-c', true, 500)

  const board = rep.getLeaderboard()
  t.is(board.length, 3)
  t.is(board[0].relay, 'relay-a', 'highest score first')
})

test('ReputationSystem - selectRelays picks best', async (t) => {
  const rep = new ReputationSystem()

  for (let i = 0; i < 20; i++) rep.recordChallenge('good', true, 100)
  for (let i = 0; i < 15; i++) rep.recordChallenge('ok', true, 300)
  for (let i = 0; i < 10; i++) rep.recordChallenge('bad', false, 0)
  for (let i = 0; i < 5; i++) rep.recordChallenge('bad', true, 1000)

  const selected = rep.selectRelays(2)
  t.is(selected.length, 2)
  t.is(selected[0], 'good', 'best relay selected first')
})

test('ReputationSystem - export and import', async (t) => {
  const rep1 = new ReputationSystem()
  for (let i = 0; i < 10; i++) rep1.recordChallenge('relay-x', true, 150)

  const exported = rep1.export()

  const rep2 = new ReputationSystem()
  rep2.import(exported)

  t.is(rep2.getScore('relay-x'), rep1.getScore('relay-x'))
  t.is(rep2.getReliability('relay-x'), 1.0)
})
