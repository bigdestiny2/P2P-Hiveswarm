import test from 'brittle'
import http from 'http'

const API_KEY = 'test-secret-key-12345'

/**
 * Create a minimal mock RelayNode that satisfies RelayAPI's needs.
 */
function mockRelayNode () {
  return {
    running: true,
    config: { storage: null, registryAutoAccept: false },
    metrics: { getSummary () { return { uptime: 100 } } },
    seededApps: new Map(),
    appRegistry: {
      get () { return null },
      has () { return false },
      apps: new Map(),
      catalog () { return [] },
      catalogForBroadcast () { return [] }
    },
    getStats () { return { running: true, seededApps: 0, connections: 0 } },
    getHealthStatus () { return { healthy: true } },
    async stop () {},
    async seedApp () { return { ok: true } },
    async unseedApp () {},
    verifyUnseedRequest () { return { ok: true } },
    broadcastUnseed () {},
    serviceRegistry: null,
    reputation: null,
    networkDiscovery: null,
    seedingRegistry: null,
    relay: null,
    seeder: null,
    swarm: null,
    on () {},
    emit () {}
  }
}

/**
 * Helper: make an HTTP request and return { statusCode, body }.
 */
function request (port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }
    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        let parsed
        try { parsed = JSON.parse(data) } catch (_) { parsed = data }
        resolve({ statusCode: res.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

let api = null
let port = 0

test('api-auth: setup server', async (t) => {
  const { RelayAPI } = await import('../../core/relay-node/api.js')
  const node = mockRelayNode()
  // Use port 0 so the OS picks a free port
  api = new RelayAPI(node, { apiPort: 0, apiKey: API_KEY, apiHost: '127.0.0.1' })

  // Override the DashboardFeed import to avoid WebSocket setup issues
  await api.start()
  port = api.server.address().port
  t.ok(port > 0, 'server started on port ' + port)
})

test('api-auth: POST /api/manage/shutdown without auth returns 401', async (t) => {
  const res = await request(port, 'POST', '/api/manage/shutdown', {})
  t.is(res.statusCode, 401, 'status is 401')
  t.ok(res.body.error, 'error message present')
})

test('api-auth: POST /api/manage/shutdown with valid Bearer token returns 200', async (t) => {
  const res = await request(port, 'POST', '/api/manage/shutdown', {}, {
    Authorization: 'Bearer ' + API_KEY
  })
  t.is(res.statusCode, 200, 'status is 200')
  t.ok(res.body.ok, 'body.ok is true')
})

test('api-auth: POST /seed without auth returns 401', async (t) => {
  const res = await request(port, 'POST', '/seed', {
    appKey: 'a'.repeat(64)
  })
  t.is(res.statusCode, 401, 'status is 401')
  t.ok(res.body.error, 'error message present')
})

test('api-auth: POST /unseed without auth returns 401', async (t) => {
  const res = await request(port, 'POST', '/unseed', {
    appKey: 'b'.repeat(64)
  })
  t.is(res.statusCode, 401, 'status is 401')
  t.ok(res.body.error, 'error message present')
})

test('api-auth: GET /health without auth returns 200 (public endpoint)', async (t) => {
  const res = await request(port, 'GET', '/health')
  t.is(res.statusCode, 200, 'status is 200')
  t.ok(res.body.ok, 'body.ok is true')
})

test('api-auth: POST /api/v1/unseed without API key auth works (developer-signed)', async (t) => {
  // This endpoint uses developer signature auth, not API key auth.
  // It should not return 401 — it will return 400 for missing fields instead.
  const res = await request(port, 'POST', '/api/v1/unseed', {})
  // Should be 400 (missing appKey), NOT 401
  t.is(res.statusCode, 400, 'status is 400 (not 401)')
  t.ok(res.body.error.includes('appKey'), 'error is about missing appKey, not auth')
})

test('api-auth: teardown server', async (t) => {
  if (api && api.server) {
    api.server.close()
    if (api._rateLimitCleanup) clearInterval(api._rateLimitCleanup)
    if (api._dashboardFeed) {
      try { api._dashboardFeed.stop() } catch (_) {}
    }
  }
  t.pass('server closed')
})
