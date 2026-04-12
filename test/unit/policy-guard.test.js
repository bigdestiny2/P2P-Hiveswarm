import test from 'brittle'
import { PolicyGuard } from '../../core/policy-guard.js'

// ─── Tier × Operation matrix ───

test('PolicyGuard - public tier + serve-code → allowed', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'public', 'serve-code')
  t.ok(result.allowed)
  t.absent(result.suspended)
})

test('PolicyGuard - local-first tier + serve-code → allowed', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'local-first', 'serve-code')
  t.ok(result.allowed)
})

test('PolicyGuard - p2p-only tier + serve-code → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'p2p-only', 'serve-code')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
  t.ok(result.reason.includes('p2p-only'))
})

test('PolicyGuard - public tier + replicate-user-data → allowed', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'public', 'replicate-user-data')
  t.ok(result.allowed)
})

test('PolicyGuard - local-first tier + replicate-user-data → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'local-first', 'replicate-user-data')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
  t.ok(result.reason.includes('local-first'))
})

test('PolicyGuard - p2p-only tier + replicate-user-data → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'p2p-only', 'replicate-user-data')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
})

test('PolicyGuard - public tier + store-on-relay → allowed', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'public', 'store-on-relay')
  t.ok(result.allowed)
})

test('PolicyGuard - local-first tier + store-on-relay → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'local-first', 'store-on-relay')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
})

test('PolicyGuard - p2p-only tier + store-on-relay → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'p2p-only', 'store-on-relay')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
})

test('PolicyGuard - unknown operation → suspended', (t) => {
  const guard = new PolicyGuard()
  const result = guard.check('aabb', 'public', 'something-weird')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
  t.ok(result.reason.includes('unknown operation'))
})

// ─── Suspension persistence ───

test('PolicyGuard - suspended app blocks ALL subsequent operations', (t) => {
  const guard = new PolicyGuard()
  // Trigger suspension
  guard.check('aabb', 'p2p-only', 'serve-code')
  t.ok(guard.isSuspended('aabb'))

  // Even a normally-allowed operation is blocked
  const result = guard.check('aabb', 'public', 'serve-code')
  t.is(result.allowed, false)
  t.is(result.suspended, true)
})

test('PolicyGuard - reinstate clears suspension', (t) => {
  const guard = new PolicyGuard()
  guard.check('aabb', 'p2p-only', 'serve-code')
  t.ok(guard.isSuspended('aabb'))

  const reinstated = guard.reinstate('aabb')
  t.is(reinstated, true)
  t.absent(guard.isSuspended('aabb'))

  // Now the same check works (if tier changed)
  const result = guard.check('aabb', 'public', 'serve-code')
  t.ok(result.allowed)
})

test('PolicyGuard - reinstate returns false for non-suspended app', (t) => {
  const guard = new PolicyGuard()
  const result = guard.reinstate('nonexistent')
  t.is(result, false)
})

test('PolicyGuard - getViolations returns all suspended apps', (t) => {
  const guard = new PolicyGuard()
  guard.check('app1', 'p2p-only', 'serve-code')
  guard.check('app2', 'local-first', 'store-on-relay')

  const violations = guard.getViolations()
  t.is(violations.length, 2)
  t.ok(violations.find(v => v.appKey === 'app1'))
  t.ok(violations.find(v => v.appKey === 'app2'))
})

// ─── Events ───

test('PolicyGuard - violation event emitted with correct payload', (t) => {
  t.plan(5)
  const guard = new PolicyGuard()

  guard.on('violation', (v) => {
    t.is(v.appKey, 'aabb')
    t.is(v.tier, 'p2p-only')
    t.is(v.action, 'suspended')
    t.ok(v.reason)
    t.ok(v.timestamp)
  })

  guard.check('aabb', 'p2p-only', 'serve-code')
})

test('PolicyGuard - reinstated event emitted', (t) => {
  t.plan(2)
  const guard = new PolicyGuard()
  guard.check('aabb', 'p2p-only', 'serve-code')

  guard.on('reinstated', (info) => {
    t.is(info.appKey, 'aabb')
    t.ok(info.was)
  })

  guard.reinstate('aabb')
})
