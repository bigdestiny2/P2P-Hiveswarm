import test from 'brittle'
import { WebSocketTransport } from 'p2p-hiverelay/transports/websocket/index.js'
import { WebSocketStream } from 'p2p-hiverelay/transports/websocket/stream.js'
import WebSocket from 'ws'

function getPort () {
  return 18000 + Math.floor(Math.random() * 2000)
}

test('WebSocketTransport - starts and listens on configured port', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => { await transport.stop() })

  await transport.start()
  t.is(transport.running, true, 'transport is running')
  t.is(transport.port, port, 'correct port')
})

test('WebSocketTransport - client connects and emits connection event', async (t) => {
  t.plan(2)

  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => {
    await transport.stop()
  })

  await transport.start()

  transport.on('connection', (stream, info) => {
    t.ok(stream, 'received stream on connection')
    t.is(info.type, 'websocket', 'info.type is websocket')
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws.on('open', resolve) })
  ws.close()
})

test('WebSocketTransport - bidirectional data flow', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => { await transport.stop() })

  await transport.start()

  const serverReceived = []
  transport.on('connection', (stream) => {
    stream.on('data', (chunk) => {
      serverReceived.push(chunk)
      // Echo back
      stream.write(Buffer.from('pong'))
    })
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws.on('open', resolve) })

  const clientReceived = []
  ws.on('message', (data) => {
    clientReceived.push(Buffer.from(data))
  })

  ws.send(Buffer.from('ping'))

  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(serverReceived.length, 1, 'server received one message')
  t.ok(Buffer.from(serverReceived[0]).toString() === 'ping', 'server got ping')
  t.is(clientReceived.length, 1, 'client received one message')
  t.ok(clientReceived[0].toString() === 'pong', 'client got pong')

  ws.close()
})

test('WebSocketTransport - binary data passes through correctly', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => { await transport.stop() })

  await transport.start()

  // Generate binary data with all byte values
  const binaryData = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) binaryData[i] = i

  const serverReceived = []
  transport.on('connection', (stream) => {
    stream.on('data', (chunk) => {
      serverReceived.push(chunk)
    })
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws.on('open', resolve) })

  ws.send(binaryData)

  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(serverReceived.length, 1, 'received one chunk')
  t.is(Buffer.compare(Buffer.from(serverReceived[0]), binaryData), 0, 'binary data matches')

  ws.close()
})

test('WebSocketTransport - multiple concurrent connections', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => { await transport.stop() })

  await transport.start()

  let connCount = 0
  transport.on('connection', () => { connCount++ })

  const clients = []
  for (let i = 0; i < 5; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve) => { ws.on('open', resolve) })
    clients.push(ws)
  }

  await new Promise((resolve) => setTimeout(resolve, 100))

  t.is(connCount, 5, 'received 5 connections')
  t.is(transport.connections.size, 5, 'tracking 5 connections')

  for (const ws of clients) ws.close()

  await new Promise((resolve) => setTimeout(resolve, 200))

  t.is(transport.connections.size, 0, 'all connections cleaned up')
})

test('WebSocketTransport - stop closes all connections and server', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  await transport.start()

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws.on('open', resolve) })

  t.is(transport.connections.size, 1, 'one connection')

  await transport.stop()

  t.is(transport.running, false, 'not running')
  t.is(transport.connections.size, 0, 'connections cleared')
  t.is(transport.server, null, 'server nulled')
})

test('WebSocketTransport - rejects connections at capacity', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port, maxConnections: 2 })

  t.teardown(async () => { await transport.stop() })

  await transport.start()

  const ws1 = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws1.on('open', resolve) })
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws2.on('open', resolve) })

  t.is(transport.connections.size, 2, 'at capacity')

  // Third connection should be rejected
  const ws3 = new WebSocket(`ws://127.0.0.1:${port}`)
  const closeCode = await new Promise((resolve) => {
    ws3.on('close', (code) => resolve(code))
  })
  t.is(closeCode, 1013, 'rejected with 1013 (Try Again Later)')

  ws1.close()
  ws2.close()
})

test('WebSocketStream - wraps WebSocket into duplex stream', async (t) => {
  const port = getPort()
  const transport = new WebSocketTransport({ port })

  t.teardown(async () => { await transport.stop() })

  await transport.start()

  transport.on('connection', (stream) => {
    t.ok(stream instanceof WebSocketStream, 'stream is WebSocketStream instance')
    t.ok(typeof stream.write === 'function', 'has write method')
    t.ok(typeof stream.on === 'function', 'has on method')
    t.ok(typeof stream.destroy === 'function', 'has destroy method')
  })

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((resolve) => { ws.on('open', resolve) })

  await new Promise((resolve) => setTimeout(resolve, 100))
  ws.close()
})
