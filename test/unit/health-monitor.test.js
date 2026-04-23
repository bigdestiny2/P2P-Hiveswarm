import test from 'brittle'
import { HealthMonitor } from 'p2p-hiverelay/core/relay-node/health-monitor.js'

function createMockNode (opts = {}) {
  const connList = opts.connections || []
  const connMap = new Map()
  for (const c of connList) {
    connMap.set(c, { lastActivity: Date.now() })
  }
  return {
    running: opts.running !== undefined ? opts.running : true,
    swarm: opts.swarm || {
      destroyed: false,
      connections: new Set(connList)
    },
    connections: connMap,
    metrics: { _errorCount: opts.errorCount || 0 },
    config: { storage: '/tmp' }
  }
}

test('HealthMonitor - reports healthy when everything is fine', async (t) => {
  const node = createMockNode({ connections: ['a', 'b'] })
  const hm = new HealthMonitor(node, { checkInterval: 999999 })

  await hm._check()
  const status = hm.getStatus()
  t.is(status.healthy, true)
  t.is(status.checks.memory.ok, true)
  t.is(status.checks.swarm.ok, true)
})

test('HealthMonitor - detects destroyed swarm', async (t) => {
  const node = createMockNode()
  node.swarm.destroyed = true

  const hm = new HealthMonitor(node, { checkInterval: 999999 })

  let criticalFired = false
  hm.on('health-critical', () => { criticalFired = true })

  await hm._check()
  const status = hm.getStatus()
  t.is(status.healthy, false)
  t.is(status.checks.swarm.ok, false)
  t.is(criticalFired, true)
})

test('HealthMonitor - detects zero connections after threshold', async (t) => {
  const node = createMockNode({ connections: [] })
  const hm = new HealthMonitor(node, {
    checkInterval: 999999,
    zeroConnectionsThreshold: -1 // trigger immediately
  })

  let warningFired = false
  hm.on('health-warning', (d) => {
    if (d.check === 'connections') warningFired = true
  })

  // First check sets _zeroConnectionsSince
  await hm._check()
  // Second check triggers warning (threshold = 0)
  await hm._check()

  t.is(warningFired, true)
})

test('HealthMonitor - log buffer works', async (t) => {
  const node = createMockNode()
  const hm = new HealthMonitor(node, { checkInterval: 999999 })

  hm.log('info', 'test', 'hello')
  hm.log('error', 'test', 'boom')
  hm.log('info', 'other', 'world')

  const all = hm.getLogs()
  t.is(all.length, 3)

  const errors = hm.getLogs({ level: 'error' })
  t.is(errors.length, 1)
  t.is(errors[0].message, 'boom')

  const testLogs = hm.getLogs({ component: 'test' })
  t.is(testLogs.length, 2)

  const limited = hm.getLogs({ limit: 1 })
  t.is(limited.length, 1)
})

test('HealthMonitor - alert cooldown prevents spam', async (t) => {
  const node = createMockNode()
  node.swarm.destroyed = true

  const hm = new HealthMonitor(node, {
    checkInterval: 999999,
    alertCooldownMs: 60_000
  })

  let alertCount = 0
  hm.on('alert', () => { alertCount++ })

  await hm._check()
  await hm._check()
  await hm._check()

  // Should only fire once due to cooldown
  t.is(alertCount, 1, 'alert fired only once due to cooldown')
})

test('HealthMonitor - disk check with valid path', async (t) => {
  const node = createMockNode()
  const hm = new HealthMonitor(node, {
    checkInterval: 999999,
    diskCheckPath: '/tmp',
    maxDiskUsagePct: 99.9 // Should be ok
  })

  await hm._check()
  const status = hm.getStatus()
  t.is(status.checks.disk.ok, true)
  t.ok(typeof status.checks.disk.usedPct === 'number')
  t.ok(typeof status.checks.disk.freeGB === 'number')
})
