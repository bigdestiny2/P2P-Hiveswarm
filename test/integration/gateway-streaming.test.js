/**
 * Integration tests for HyperGateway streaming + Range support (Fix 2.2).
 *
 * Boots a single relay node, seeds a Hyperdrive containing files of varying
 * sizes, mounts a HyperGateway, and exercises the HTTP surface end-to-end:
 *
 *   - small text file streams with the right Content-Type
 *   - 5 MiB binary file streams without buffering and arrives byte-identical
 *   - Range: bytes=0-99 → 206 + Content-Range + correct slice
 *   - Range: bytes=100-199 → 206 + correct slice from offset 100
 *   - invalid range → 416
 *   - Accept-Ranges: bytes is on every response
 *   - path traversal attempts are rejected with 403
 *
 * The gateway is shared with the relay's Corestore (the production wiring),
 * so the same drive instance held by `seededApps` is what the gateway serves.
 */

import test from 'brittle'
import { createServer } from 'http'
import createTestnet from '@hyperswarm/testnet'
import b4a from 'b4a'
import path from 'path'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import { HyperGateway } from 'p2p-hiverelay/gateway'

function tmpStorage () {
  return path.join(tmpdir(), 'hiverelay-gw-' + randomBytes(8).toString('hex'))
}

function createNode (testnet) {
  return new RelayNode({
    storage: tmpStorage(),
    bootstrapNodes: testnet.bootstrap,
    enableAPI: false,
    enableMetrics: false,
    enableServices: false
  })
}

/**
 * Boot a relay, seed an in-process Hyperdrive against it, mount a gateway,
 * and start a tiny HTTP server in front. Returns helpers + teardown.
 */
async function bootGateway (t, files) {
  const testnet = await createTestnet(3)
  const node = createNode(testnet)
  await node.start()

  // Create a drive directly on the relay's main Corestore. We hand the
  // exact same drive instance to the gateway via its private cache so
  // there's no need to wait for replication — this is an in-process test.
  const Hyperdrive = (await import('hyperdrive')).default
  const drive = new Hyperdrive(node.store.namespace('test-drive'))
  await drive.ready()

  for (const [filePath, content] of Object.entries(files)) {
    await drive.put(filePath, content)
  }

  const keyHex = b4a.toString(drive.key, 'hex')

  // Register the drive in seededApps so the gateway authorization checks pass.
  node.seededApps.set(keyHex, {
    drive,
    privacyTier: 'public',
    blind: false
  })

  const gateway = new HyperGateway(node, { store: node.store })

  // Short-circuit gateway's drive lookup: pre-seed the LRU with our drive so
  // it never tries to open a fresh (empty) instance from its own namespace.
  gateway._drives.set(keyHex, drive)

  const server = createServer((req, res) => {
    if (req.url.startsWith('/v1/hyper/')) return gateway.handle(req, res)
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port

  t.teardown(async () => {
    await new Promise(resolve => server.close(resolve))
    try { await gateway.close() } catch {}
    try { await drive.close() } catch {}
    await node.stop()
    await testnet.destroy()
  })

  return {
    keyHex,
    drive,
    url: (filePath) => `http://127.0.0.1:${port}/v1/hyper/${keyHex}${filePath}`,
    rawUrl: (suffix) => `http://127.0.0.1:${port}${suffix}`
  }
}

// ─── Small file streams correctly with right Content-Type ──────────

test('integration: small file streams with correct Content-Type', async (t) => {
  const ctx = await bootGateway(t, {
    '/hello.txt': b4a.from('hello world')
  })

  const res = await fetch(ctx.url('/hello.txt'))
  t.is(res.status, 200, 'returns 200')
  t.is(res.headers.get('content-type'), 'text/plain; charset=utf-8', 'text/plain content-type')
  t.is(res.headers.get('content-length'), '11', 'content-length is set')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges header present')

  const body = await res.text()
  t.is(body, 'hello world', 'body matches')
})

// ─── PNG content-type from extension map ───────────────────────────

test('integration: PNG file gets image/png Content-Type', async (t) => {
  const fakePng = b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ctx = await bootGateway(t, {
    '/icon.png': fakePng
  })

  const res = await fetch(ctx.url('/icon.png'))
  t.is(res.status, 200, '200 OK')
  t.is(res.headers.get('content-type'), 'image/png', 'image/png content-type')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges present on binaries')

  const body = b4a.from(await res.arrayBuffer())
  t.ok(b4a.equals(body, fakePng), 'PNG bytes match')
})

// ─── Unknown extension → octet-stream ──────────────────────────────

test('integration: unknown extension maps to application/octet-stream', async (t) => {
  const ctx = await bootGateway(t, {
    '/blob.weird': b4a.from('xyz')
  })

  const res = await fetch(ctx.url('/blob.weird'))
  t.is(res.status, 200, '200 OK')
  t.is(res.headers.get('content-type'), 'application/octet-stream', 'octet-stream fallback')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges present')
})

// ─── Large-ish file streams without buffering issues ───────────────

test('integration: 5MB file streams correctly end-to-end', async (t) => {
  const big = randomBytes(5 * 1024 * 1024) // 5 MiB
  const ctx = await bootGateway(t, {
    '/big.bin': big
  })

  const res = await fetch(ctx.url('/big.bin'))
  t.is(res.status, 200, '200 OK on large file')
  t.is(res.headers.get('content-length'), String(big.length), 'content-length matches 5MB')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges present')

  const body = b4a.from(await res.arrayBuffer())
  t.is(body.length, big.length, 'received exactly 5MB')
  t.ok(b4a.equals(body, big), '5MB body bytes are byte-identical')
})

// ─── Range: bytes=0-99 returns first 100 bytes with 206 ────────────

test('integration: Range bytes=0-99 returns 206 with correct slice', async (t) => {
  const data = randomBytes(2048)
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=0-99' }
  })
  t.is(res.status, 206, 'returns 206 Partial Content')
  t.is(res.headers.get('content-range'), `bytes 0-99/${data.length}`, 'content-range correct')
  t.is(res.headers.get('content-length'), '100', 'content-length is 100')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges present')

  const body = b4a.from(await res.arrayBuffer())
  t.is(body.length, 100, 'received exactly 100 bytes')
  t.ok(b4a.equals(body, data.slice(0, 100)), 'first 100 bytes match')
})

// ─── Range: bytes=100-199 returns slice from offset 100 ────────────

test('integration: Range bytes=100-199 returns slice from offset 100', async (t) => {
  const data = randomBytes(2048)
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=100-199' }
  })
  t.is(res.status, 206, '206 Partial Content')
  t.is(res.headers.get('content-range'), `bytes 100-199/${data.length}`, 'content-range correct')
  t.is(res.headers.get('content-length'), '100', 'content-length is 100')

  const body = b4a.from(await res.arrayBuffer())
  t.is(body.length, 100, 'received 100 bytes')
  t.ok(b4a.equals(body, data.slice(100, 200)), 'bytes [100, 200) match')
})

// ─── Open-ended range: bytes=N- returns from N to EOF ──────────────

test('integration: Range bytes=N- returns from offset N to EOF', async (t) => {
  const data = randomBytes(512)
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=400-' }
  })
  t.is(res.status, 206, '206 Partial Content')
  t.is(res.headers.get('content-range'), `bytes 400-511/${data.length}`, 'content-range covers tail')
  t.is(res.headers.get('content-length'), '112', 'content-length is 112')

  const body = b4a.from(await res.arrayBuffer())
  t.ok(b4a.equals(body, data.slice(400)), 'tail slice matches')
})

// ─── Suffix range: bytes=-N returns last N bytes ───────────────────

test('integration: suffix range bytes=-N returns last N bytes', async (t) => {
  const data = randomBytes(1024)
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=-50' }
  })
  t.is(res.status, 206, '206 Partial Content')
  const expectedStart = data.length - 50
  t.is(res.headers.get('content-range'), `bytes ${expectedStart}-${data.length - 1}/${data.length}`, 'content-range matches suffix')

  const body = b4a.from(await res.arrayBuffer())
  t.ok(b4a.equals(body, data.slice(expectedStart)), 'last 50 bytes match')
})

// ─── Invalid range (start > end) returns 416 ──────────────────────

test('integration: invalid Range (start > end) returns 416', async (t) => {
  const data = b4a.from('abcdefghij')
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=5-2' }
  })
  t.is(res.status, 416, '416 Range Not Satisfiable')
  t.is(res.headers.get('content-range'), `bytes */${data.length}`, 'unsatisfied content-range')
  // drain
  await res.arrayBuffer()
})

// ─── Range starting past EOF returns 416 ───────────────────────────

test('integration: Range past EOF returns 416', async (t) => {
  const data = b4a.from('short')
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), {
    headers: { Range: 'bytes=100-200' }
  })
  t.is(res.status, 416, '416 Range Not Satisfiable')
  t.is(res.headers.get('content-range'), `bytes */${data.length}`, 'unsatisfied content-range')
  await res.arrayBuffer()
})

// ─── Accept-Ranges: bytes header on every response ─────────────────

test('integration: Accept-Ranges header is present on all 200/206 responses', async (t) => {
  const ctx = await bootGateway(t, {
    '/a.txt': b4a.from('a'),
    '/b.png': b4a.from([0x89, 0x50]),
    '/c.bin': randomBytes(100)
  })

  for (const p of ['/a.txt', '/b.png', '/c.bin']) {
    const res = await fetch(ctx.url(p))
    t.is(res.headers.get('accept-ranges'), 'bytes', `${p} has accept-ranges`)
    await res.arrayBuffer()
  }

  // And on a 206 too
  const ranged = await fetch(ctx.url('/c.bin'), { headers: { Range: 'bytes=0-9' } })
  t.is(ranged.status, 206, '206 returned')
  t.is(ranged.headers.get('accept-ranges'), 'bytes', '206 also carries accept-ranges')
  await ranged.arrayBuffer()
})

// ─── Path traversal rejected with 403 ──────────────────────────────

test('integration: path traversal attempts are rejected with 403', async (t) => {
  const ctx = await bootGateway(t, {
    '/index.css': b4a.from('body{}')
  })

  // Encoded ../ traversal
  const res1 = await fetch(ctx.rawUrl(`/v1/hyper/${ctx.keyHex}/..%2Fetc%2Fpasswd`))
  t.is(res1.status, 403, 'encoded ../ rejected with 403')
  await res1.text()

  // Direct ../ traversal — fetch normalizes the URL client-side, so the
  // server may see a path that no longer matches /v1/hyper/<key>/... and
  // return 400 ("Invalid path" / "Invalid drive key"). Anything in the
  // 4xx range that isn't 200 means the traversal was not honored.
  const res2 = await fetch(ctx.rawUrl(`/v1/hyper/${ctx.keyHex}/../etc/passwd`))
  t.ok(res2.status >= 400 && res2.status < 500, `traversal blocked (got ${res2.status})`)
  await res2.text()

  // Double-encoded ..
  const res3 = await fetch(ctx.rawUrl(`/v1/hyper/${ctx.keyHex}/%252e%252e/etc/passwd`))
  t.is(res3.status, 403, 'double-encoded .. rejected with 403')
  await res3.text()
})

// ─── HEAD request returns headers without body ─────────────────────

test('integration: HEAD request returns headers without body', async (t) => {
  const data = randomBytes(1024)
  const ctx = await bootGateway(t, {
    '/data.bin': data
  })

  const res = await fetch(ctx.url('/data.bin'), { method: 'HEAD' })
  t.is(res.status, 200, '200 OK on HEAD')
  t.is(res.headers.get('content-length'), String(data.length), 'content-length present on HEAD')
  t.is(res.headers.get('accept-ranges'), 'bytes', 'accept-ranges present on HEAD')

  const body = b4a.from(await res.arrayBuffer())
  t.is(body.length, 0, 'HEAD body is empty')
})
