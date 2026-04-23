import test from 'brittle'
import { HolesailTransport } from 'p2p-hiverelay/transports/holesail/index.js'

test('HolesailTransport — constructor defaults', async (t) => {
  const ht = new HolesailTransport()
  t.is(ht.apiPort, 9100)
  t.is(ht.apiHost, '127.0.0.1')
  t.is(ht.running, false)
  t.is(ht.connectionKey, null)
  t.is(ht.seed, null)
})

test('HolesailTransport — constructor with opts', async (t) => {
  const ht = new HolesailTransport({
    apiPort: 3000,
    host: '0.0.0.0',
    seed: 'a'.repeat(64)
  })
  t.is(ht.apiPort, 3000)
  t.is(ht.apiHost, '0.0.0.0')
  t.is(ht.seed, 'a'.repeat(64))
})

test('HolesailTransport — getInfo before start', async (t) => {
  const ht = new HolesailTransport()
  const info = ht.getInfo()
  t.is(info.running, false)
  t.is(info.connectionKey, null)
})

test.skip('HolesailTransport — connector mode start and stop', async (t) => {
  const ht = new HolesailTransport({
    connectorMode: true,
    port: 19876,
    seed: 'a'.repeat(64)
  })

  const started = new Promise(resolve => ht.on('started', resolve))
  await ht.start()
  const info = await started

  t.is(ht.running, true)
  t.is(info.mode, 'connector')
  t.ok(ht.connectionKey)
  t.ok(ht.connectionUrl)
  t.ok(ht.connectionUrl.startsWith('hs://'))

  const htInfo = ht.getInfo()
  t.is(htInfo.running, true)
  t.is(htInfo.mode, 'connector')
  t.ok(htInfo.connectionKey)

  await ht.stop()
  t.is(ht.running, false)
})

test.skip('HolesailTransport — tunnel mode start and stop', async (t) => {
  const ht = new HolesailTransport({
    connectorMode: false,
    port: 19877,
    seed: 'b'.repeat(64)
  })

  const started = new Promise(resolve => ht.on('started', resolve))
  await ht.start()
  const info = await started

  t.is(ht.running, true)
  t.is(info.mode, 'tunnel')
  t.ok(ht.connectionKey)
  t.ok(ht.connectionUrl)

  await ht.stop()
  t.is(ht.running, false)
})

test.skip('HolesailTransport — deterministic key from seed', async (t) => {
  const seed = 'c'.repeat(64)

  const ht1 = new HolesailTransport({ connectorMode: true, port: 19878, seed })
  await ht1.start()
  const key1 = ht1.connectionKey

  await ht1.stop()

  const ht2 = new HolesailTransport({ connectorMode: true, port: 19879, seed })
  await ht2.start()
  const key2 = ht2.connectionKey

  await ht2.stop()

  // Same seed should produce same key
  t.is(key1, key2)
})

test.skip('HolesailTransport — stop is idempotent', async (t) => {
  const ht = new HolesailTransport({ connectorMode: true, port: 19880, seed: 'd'.repeat(64) })
  await ht.start()
  await ht.stop()
  await ht.stop() // Should not throw
  t.is(ht.running, false)
})

test.skip('HolesailTransport — double start is safe', async (t) => {
  const ht = new HolesailTransport({ connectorMode: true, port: 19881, seed: 'e'.repeat(64) })
  await ht.start()
  await ht.start() // Should not throw
  t.is(ht.running, true)
  await ht.stop()
})
