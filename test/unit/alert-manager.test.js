import test from 'brittle'
import { createServer } from 'http'
import { EventEmitter } from 'events'
import { AlertManager } from '../../core/relay-node/alert-manager.js'

function createMockNode () {
  const node = new EventEmitter()
  node.healthMonitor = null
  node.api = null
  return node
}

async function startCapturingServer () {
  const received = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('AlertManager - cooldown suppresses duplicates', async (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  const a1 = am.fire({ type: 'memory-high', key: 'mem', severity: 'warn', message: 'first' })
  const a2 = am.fire({ type: 'memory-high', key: 'mem', severity: 'warn', message: 'second' })
  const different = am.fire({ type: 'disk-low', key: 'disk', severity: 'warn', message: 'disk' })

  t.is(a1, true, 'first fires')
  t.is(a2, false, 'duplicate within cooldown suppressed')
  t.is(different, true, 'different type/key still fires')

  am.stop()
})

test('AlertManager - cooldown respects configured window', async (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 1, // 1 ms — effectively no cooldown after a tick
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  const a1 = am.fire({ type: 'memory-high', key: 'mem', severity: 'warn', message: 'first' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const a2 = am.fire({ type: 'memory-high', key: 'mem', severity: 'warn', message: 'second' })

  t.is(a1, true)
  t.is(a2, true)
  am.stop()
})

test('AlertManager - severity filtering (info blocked when threshold is warn)', (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  const info = am.fire({ type: 'test', key: 'a', severity: 'info', message: 'i' })
  const warn = am.fire({ type: 'test', key: 'b', severity: 'warn', message: 'w' })
  const error = am.fire({ type: 'test', key: 'c', severity: 'error', message: 'e' })
  const crit = am.fire({ type: 'test', key: 'd', severity: 'critical', message: 'c' })

  t.is(info, false, 'info filtered')
  t.is(warn, true, 'warn passes')
  t.is(error, true, 'error passes')
  t.is(crit, true, 'critical passes')
  am.stop()
})

test('AlertManager - webhook channel POSTs JSON', async (t) => {
  const node = createMockNode()
  const { url, received, close } = await startCapturingServer()

  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: {
      webhook: { url, timeout: 5000 },
      console: { enabled: false }
    }
  })

  let alertEmitted = null
  am.on('alert', (a) => { alertEmitted = a })

  am.fire({ type: 'health-check-failed', key: 'k1', severity: 'error', message: 'boom' })

  // Wait for HTTP POST to land
  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(received.length, 1, 'one request received')
  t.is(received[0].method, 'POST')
  t.is(received[0].headers['content-type'], 'application/json')
  const parsed = JSON.parse(received[0].body)
  t.is(parsed.type, 'health-check-failed')
  t.is(parsed.severity, 'error')
  t.is(parsed.message, 'boom')
  t.ok(alertEmitted)

  am.stop()
  await close()
})

test('AlertManager - multiple channels each receive the alert', async (t) => {
  const node = createMockNode()
  const hook1 = await startCapturingServer()
  const hook2 = await startCapturingServer()

  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: {
      webhook: { url: hook1.url, timeout: 5000 },
      discord: { webhookUrl: hook2.url, timeout: 5000 },
      console: { enabled: false }
    }
  })

  am.fire({ type: 'service-start-failed', key: 'svc', severity: 'critical', message: 'down' })

  await new Promise((resolve) => setTimeout(resolve, 300))

  t.is(hook1.received.length, 1, 'webhook hit')
  t.is(hook2.received.length, 1, 'discord hit')

  // Discord payload should have an embeds array
  const discordPayload = JSON.parse(hook2.received[0].body)
  t.ok(Array.isArray(discordPayload.embeds), 'discord payload has embeds')
  t.is(discordPayload.embeds[0].description, 'down')

  am.stop()
  await hook1.close()
  await hook2.close()
})

test('AlertManager - alerts appear in log', (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  am.fire({ type: 'memory-high', key: 'mem', severity: 'warn', message: 'm' })
  am.fire({ type: 'disk-low', key: 'disk', severity: 'warn', message: 'd' })
  am.fire({ type: 'service-start-failed', key: 'svc', severity: 'critical', message: 's' })

  const log = am.getLog({ limit: 10 })
  t.is(log.total, 3)
  t.is(log.items.length, 3)
  // Newest first
  t.is(log.items[0].type, 'service-start-failed')

  // Filter by severity
  const crit = am.getLog({ severity: 'critical' })
  t.is(crit.items.length, 1)

  am.stop()
})

test('AlertManager - fireTest bypasses cooldown', (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  const first = am.fireTest({ message: 'one' })
  const second = am.fireTest({ message: 'two' })
  t.is(first, true)
  t.is(second, true, 'fireTest bypasses cooldown')
  am.stop()
})

test('AlertManager - node event wiring routes policy-violation', (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: true,
    cooldown: 60_000,
    severityThreshold: 'warn',
    channels: { console: { enabled: false } }
  })

  let fired = null
  am.on('alert', (a) => { fired = a })

  node.emit('privacy-violation', { rule: 'no-public-app' })

  t.ok(fired, 'alert fired for policy violation')
  t.is(fired.type, 'policy-violation')
  t.is(fired.severity, 'warn')
  am.stop()
})

test('AlertManager - disabled manager does not fire', (t) => {
  const node = createMockNode()
  const am = new AlertManager(node, {
    enabled: false,
    channels: { console: { enabled: false } }
  })

  const result = am.fire({ type: 'x', key: 'y', severity: 'critical', message: 'no' })
  t.is(result, false)
  t.is(am.getLog().total, 0)
})
