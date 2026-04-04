import test from 'brittle'
import { Relay } from '../../core/relay-node/relay.js'
import { EventEmitter } from 'events'

function mockStream () {
  const s = new EventEmitter()
  s._written = []
  s._paused = false
  s._destroyed = false
  s._drainFull = false
  s.write = (chunk) => {
    s._written.push(chunk)
    if (s._drainFull) return false
    return true
  }
  s.pause = () => { s._paused = true }
  s.resume = () => { s._paused = false }
  s.destroy = () => { s._destroyed = true }
  return s
}

test('Relay - basic forwarding', async (t) => {
  const relay = new Relay(null, { maxConnections: 10 })
  await relay.start()

  const src = mockStream()
  const dst = mockStream()

  relay.createCircuit('c1', src, dst)

  const chunk = Buffer.from('hello')
  src.emit('data', chunk)

  t.is(dst._written.length, 1)
  t.ok(Buffer.compare(dst._written[0], chunk) === 0, 'dest received chunk')
  t.is(relay.totalBytesRelayed, 5)

  // Reverse direction
  const chunk2 = Buffer.from('world')
  dst.emit('data', chunk2)
  t.is(src._written.length, 1)
  t.is(relay.totalBytesRelayed, 10)

  await relay.stop()
})

test('Relay - byte limit enforcement', async (t) => {
  t.plan(2)
  const relay = new Relay(null, { maxConnections: 10, maxCircuitBytes: 10 })
  await relay.start()

  const src = mockStream()
  const dst = mockStream()

  relay.on('circuit-closed', ({ reason }) => {
    t.is(reason, 'BYTES_EXCEEDED')
  })

  relay.createCircuit('c1', src, dst)
  src.emit('data', Buffer.alloc(11))

  t.is(relay.circuits.size, 0, 'circuit removed')
  await relay.stop()
})

test('Relay - duration timeout', async (t) => {
  t.plan(1)
  const relay = new Relay(null, { maxConnections: 10, maxCircuitDuration: 50 })
  await relay.start()

  const src = mockStream()
  const dst = mockStream()

  relay.on('circuit-closed', ({ reason }) => {
    t.is(reason, 'DURATION_EXCEEDED')
  })

  relay.createCircuit('c1', src, dst)

  await new Promise((resolve) => setTimeout(resolve, 100))
  await relay.stop()
})

test('Relay - capacity limit', async (t) => {
  const relay = new Relay(null, { maxConnections: 1 })
  await relay.start()

  relay.createCircuit('c1', mockStream(), mockStream())

  try {
    relay.createCircuit('c2', mockStream(), mockStream())
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'RELAY_AT_CAPACITY')
  }

  await relay.stop()
})

test('Relay - backpressure', async (t) => {
  const relay = new Relay(null, { maxConnections: 10 })
  await relay.start()

  const src = mockStream()
  const dst = mockStream()
  dst._drainFull = true // write() returns false

  relay.createCircuit('c1', src, dst)

  src.emit('data', Buffer.from('x'))
  t.ok(src._paused, 'source paused when dest is full')

  dst.emit('drain')
  t.ok(!src._paused, 'source resumed after drain')

  await relay.stop()
})

test('Relay - stop closes all circuits', async (t) => {
  const relay = new Relay(null, { maxConnections: 10 })
  await relay.start()

  const streams = []
  for (let i = 0; i < 3; i++) {
    const s = mockStream()
    const d = mockStream()
    streams.push(s, d)
    relay.createCircuit(`c${i}`, s, d)
  }

  t.is(relay.circuits.size, 3)
  await relay.stop()
  t.is(relay.circuits.size, 0)

  for (const s of streams) {
    t.ok(s._destroyed, 'stream destroyed')
  }
})

test('Relay - getStats shape', async (t) => {
  const relay = new Relay(null)
  const stats = relay.getStats()

  t.ok('activeCircuits' in stats)
  t.ok('totalCircuitsServed' in stats)
  t.ok('totalBytesRelayed' in stats)
  t.ok('capacityUsedPct' in stats)
})
