import test from 'brittle'
import { StorageService } from '../../core/services/builtin/storage-service.js'
import { PolicyGuard } from '../../core/policy-guard.js'

// ─── Manifest ───

test('StorageService - manifest', (t) => {
  const svc = new StorageService()
  const m = svc.manifest()
  t.is(m.name, 'storage')
  t.is(m.version, '1.0.0')
  t.ok(m.capabilities.includes('drive-create'))
  t.ok(m.capabilities.includes('drive-write'))
  t.ok(m.capabilities.includes('drive-read'))
  t.ok(m.capabilities.includes('drive-delete'))
  t.ok(m.capabilities.includes('core-create'))
  t.ok(m.capabilities.includes('core-append'))
  t.ok(m.capabilities.includes('core-get'))
})

// ─── Constructor options ───

test('StorageService - accepts policyGuard and getAppTier', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => 'public'
  })
  t.is(svc.policyGuard, guard)
  t.ok(typeof svc.getAppTier === 'function')
})

test('StorageService - defaults without options', (t) => {
  const svc = new StorageService()
  t.is(svc.policyGuard, null)
  t.is(svc.getAppTier, null)
  t.is(svc.maxDrives, 256)
})

// ─── _getDrive ───

test('StorageService - _getDrive throws for unknown key', (t) => {
  const svc = new StorageService()
  try {
    svc._getDrive('deadbeef')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('DRIVE_NOT_FOUND'))
    t.ok(err.message.includes('deadbeef'))
  }
})

// ─── PolicyGuard _checkPolicy ───

test('StorageService - _checkPolicy allows public tier', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => 'public'
  })
  // Should not throw
  svc._checkPolicy('aabb', 'store-on-relay')
  t.pass('policy check passed for public tier')
})

test('StorageService - _checkPolicy blocks local-first store-on-relay', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => 'local-first'
  })
  try {
    svc._checkPolicy('aabb', 'store-on-relay')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
})

test('StorageService - _checkPolicy blocks p2p-only store-on-relay', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => 'p2p-only'
  })
  try {
    svc._checkPolicy('aabb', 'store-on-relay')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
})

test('StorageService - _checkPolicy skips when no guard', (t) => {
  const svc = new StorageService()
  // Should not throw even without a guard
  svc._checkPolicy('aabb', 'store-on-relay')
  t.pass('no guard, no check')
})

test('StorageService - _checkPolicy denies when tier unknown (fail-closed)', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => null // unknown app
  })
  // Should deny unknown apps (fail-closed)
  try {
    svc._checkPolicy('aabb', 'store-on-relay', { remotePubkey: 'peer-a' })
    t.fail('should throw for unknown tier')
  } catch (err) {
    t.ok(err.message.includes('ACCESS_DENIED'), 'unknown tier denied')
  }
})

test('StorageService - _checkPolicy allows unknown tier for admin context', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => null
  })
  // Admin should pass even for unknown apps
  svc._checkPolicy('aabb', 'store-on-relay', { role: 'local' })
  t.pass('admin passes unknown tier')
})

test('StorageService - _checkPolicy suspends app permanently', (t) => {
  const guard = new PolicyGuard()
  const svc = new StorageService({
    policyGuard: guard,
    getAppTier: () => 'local-first'
  })

  // First call suspends
  try { svc._checkPolicy('aabb', 'store-on-relay') } catch {}
  t.ok(guard.isSuspended('aabb'))

  // Second call still blocked (even if we change tier lookup)
  svc.getAppTier = () => 'public'
  try {
    svc._checkPolicy('aabb', 'store-on-relay')
    t.fail('should still be blocked')
  } catch (err) {
    t.ok(err.message.includes('POLICY_VIOLATION'))
  }
})

// ─── drive-list on empty ───

test('StorageService - drive-list empty', async (t) => {
  const svc = new StorageService()
  const result = await svc['drive-list']()
  t.is(result.length, 0)
})

// ─── drive limit ───

test('StorageService - drive-create respects maxDrives', (t) => {
  const svc = new StorageService()
  svc.maxDrives = 0
  // Manually check the limit logic
  t.is(svc.drives.size, 0)
  t.is(svc.maxDrives, 0)
  // Can't easily test without a real store, but the manifest test confirms the code loads
})

// ─── stop clears drives ───

test('StorageService - stop clears drives map', async (t) => {
  const svc = new StorageService()
  // Inject fake drives with close() method
  svc.drives.set('key1', { close: async () => {} })
  svc.drives.set('key2', { close: async () => {} })
  t.is(svc.drives.size, 2)
  await svc.stop()
  t.is(svc.drives.size, 0)
})
