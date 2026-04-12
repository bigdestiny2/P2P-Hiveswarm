import test from 'brittle'
import { Router } from '../../core/router/index.js'
import { PubSub } from '../../core/router/pubsub.js'

// --- Router Tests ---

test('Router - addRoute and dispatch', async (t) => {
  const router = new Router()
  router.addRoute('test.echo', async (params) => ({ echo: params.msg }))
  await router.start()

  const result = await router.dispatch('test.echo', { msg: 'hello' })
  t.is(result.echo, 'hello')

  await router.stop()
})

test('Router - dispatch unknown route throws ROUTE_NOT_FOUND', async (t) => {
  const router = new Router()
  await router.start()

  try {
    await router.dispatch('nonexistent.route')
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('ROUTE_NOT_FOUND'))
  }

  await router.stop()
})

test('Router - fallback to registry', async (t) => {
  // Mock registry
  const registry = {
    handleRequest: async (service, method, params) => {
      return { service, method, fromRegistry: true }
    }
  }

  const router = new Router({ registry })
  await router.start()

  const result = await router.dispatch('storage.get', { key: 'foo' })
  t.is(result.service, 'storage')
  t.is(result.method, 'get')
  t.is(result.fromRegistry, true)

  await router.stop()
})

test('Router - registerFromRegistry auto-generates routes', async (t) => {
  const handler = async (params) => ({ found: true })
  const mockProvider = {
    manifest: () => ({
      name: 'identity',
      version: '1.0.0',
      capabilities: ['whoami', 'verify']
    }),
    whoami: handler,
    verify: handler
  }

  const registry = {
    services: new Map([['identity', { provider: mockProvider }]])
  }

  const router = new Router({ registry })
  router.registerFromRegistry(registry)
  await router.start()

  const result = await router.dispatch('identity.whoami', {})
  t.is(result.found, true)

  const routes = router.routes()
  t.ok(routes.includes('identity.whoami'))
  t.ok(routes.includes('identity.verify'))

  await router.stop()
})

test('Router - middleware can modify params', async (t) => {
  const router = new Router({
    middleware: [
      async (route, params) => {
        return { params: { ...params, injected: true } }
      }
    ]
  })

  router.addRoute('test.mw', async (params) => params)
  await router.start()

  const result = await router.dispatch('test.mw', { original: true })
  t.is(result.original, true)
  t.is(result.injected, true)

  await router.stop()
})

test('Router - middleware can reject', async (t) => {
  const router = new Router({
    middleware: [async () => false]
  })

  router.addRoute('test.blocked', async () => 'should not reach')
  await router.start()

  try {
    await router.dispatch('test.blocked')
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('MIDDLEWARE_REJECTED'))
  }

  await router.stop()
})

test('Router - removeRoute', async (t) => {
  const router = new Router()
  router.addRoute('test.remove', async () => 'exists')
  await router.start()

  const result = await router.dispatch('test.remove')
  t.is(result, 'exists')

  router.removeRoute('test.remove')

  try {
    await router.dispatch('test.remove')
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('ROUTE_NOT_FOUND'))
  }

  await router.stop()
})

test('Router - getStats', async (t) => {
  const router = new Router()
  router.addRoute('a.b', async () => {})
  router.addRoute('c.d', async () => {})
  await router.start()

  const stats = router.getStats()
  t.is(stats.routes, 2)
  t.ok(stats.pubsub)
  t.is(stats.pubsub.topics, 0)
  t.is(stats.pubsub.subscribers, 0)

  await router.stop()
})

test('Router - context passed to handler', async (t) => {
  const router = new Router()
  router.addRoute('test.ctx', async (params, ctx) => ctx)
  await router.start()

  const ctx = await router.dispatch('test.ctx', {}, { transport: 'http', ip: '127.0.0.1' })
  t.is(ctx.transport, 'http')
  t.is(ctx.ip, '127.0.0.1')

  await router.stop()
})

// --- PubSub Tests ---

test('PubSub - subscribe and publish exact topic', async (t) => {
  const ps = new PubSub()
  const received = []

  ps.subscribe('events/seeding', (topic, data) => {
    received.push({ topic, data })
  })

  await ps.publish('events/seeding', { appKey: 'abc' })
  t.is(received.length, 1)
  t.is(received[0].topic, 'events/seeding')
  t.is(received[0].data.appKey, 'abc')

  ps.destroy()
})

test('PubSub - glob pattern subscription', async (t) => {
  const ps = new PubSub()
  const received = []

  ps.subscribe('events/*', (topic, data) => {
    received.push(topic)
  })

  await ps.publish('events/seeding', { key: 1 })
  await ps.publish('events/connection', { key: 2 })
  await ps.publish('other/topic', { key: 3 })

  t.is(received.length, 2)
  t.ok(received.includes('events/seeding'))
  t.ok(received.includes('events/connection'))

  ps.destroy()
})

test('PubSub - unsubscribe', async (t) => {
  const ps = new PubSub()
  let count = 0

  const subId = ps.subscribe('test', () => { count++ })
  await ps.publish('test', {})
  t.is(count, 1)

  ps.unsubscribe(subId)
  await ps.publish('test', {})
  t.is(count, 1) // no change

  ps.destroy()
})

test('PubSub - filter predicate', async (t) => {
  const ps = new PubSub()
  const received = []

  ps.subscribe('data', (topic, data) => {
    received.push(data)
  }, { filter: (data) => data.important === true })

  await ps.publish('data', { important: true, msg: 'yes' })
  await ps.publish('data', { important: false, msg: 'no' })

  t.is(received.length, 1)
  t.is(received[0].msg, 'yes')

  ps.destroy()
})

test('PubSub - subscriber error does not kill other subscribers', async (t) => {
  const ps = new PubSub()
  const results = []

  ps.subscribe('test', () => { throw new Error('bad subscriber') })
  ps.subscribe('test', (topic, data) => { results.push(data) })

  const delivered = await ps.publish('test', { ok: true })
  t.is(results.length, 1)
  t.is(delivered, 1) // Only the successful one counts

  ps.destroy()
})

test('PubSub - topicCount and subscriberCount', async (t) => {
  const ps = new PubSub()

  ps.subscribe('a', () => {})
  ps.subscribe('b', () => {})
  ps.subscribe('b', () => {})
  ps.subscribe('c/*', () => {})

  t.is(ps.topicCount(), 3) // 2 exact + 1 pattern
  t.is(ps.subscriberCount(), 4)

  ps.destroy()
})

test('PubSub - max topics enforced', async (t) => {
  const ps = new PubSub({ maxTopics: 2 })

  ps.subscribe('a', () => {})
  ps.subscribe('b', () => {})

  try {
    ps.subscribe('c', () => {})
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('PUBSUB_MAX_TOPICS'))
  }

  ps.destroy()
})

test('PubSub - publish returns 0 for no subscribers', async (t) => {
  const ps = new PubSub()
  const count = await ps.publish('nobody-listens', {})
  t.is(count, 0)
  ps.destroy()
})

test('PubSub - multiple glob patterns', async (t) => {
  const ps = new PubSub()
  const received = []

  ps.subscribe('services/*', (t, d) => received.push('services'))
  ps.subscribe('*', (t, d) => received.push('star'))

  // "services/storage" should match "services/*" but NOT "*" (single segment)
  await ps.publish('services/storage', {})
  t.is(received.length, 1) // Only services/* matches
  t.is(received[0], 'services')

  ps.destroy()
})

// --- Router Upgrade Tests ---

test('Router - dispatch injects traceId', async (t) => {
  const router = new Router()
  let capturedCtx = null
  router.addRoute('test.trace', async (params, ctx) => { capturedCtx = ctx; return 'ok' })
  await router.start()

  await router.dispatch('test.trace', {}, {})
  t.ok(capturedCtx.traceId)
  t.is(capturedCtx.traceId.length, 16) // 8 bytes hex

  await router.stop()
})

test('Router - dispatch preserves existing traceId', async (t) => {
  const router = new Router()
  let capturedCtx = null
  router.addRoute('test.trace', async (params, ctx) => { capturedCtx = ctx })
  await router.start()

  await router.dispatch('test.trace', {}, { traceId: 'my-trace-123' })
  t.is(capturedCtx.traceId, 'my-trace-123')

  await router.stop()
})

test('Router - per-route rate limiting', async (t) => {
  const router = new Router()
  router.addRoute('test.limited', async () => 'ok', { rateLimit: { tokensPerMin: 2, burst: 2 } })
  await router.start()

  const ctx = { remotePubkey: 'peer1' }
  const r1 = await router.dispatch('test.limited', {}, ctx)
  t.is(r1, 'ok')

  const r2 = await router.dispatch('test.limited', {}, ctx)
  t.is(r2, 'ok')

  // Third call should be rate limited
  try {
    await router.dispatch('test.limited', {}, ctx)
    t.fail('should be rate limited')
  } catch (err) {
    t.ok(err.message.includes('RATE_LIMITED'))
  }

  await router.stop()
})

test('Router - rate limit does not apply without remotePubkey', async (t) => {
  const router = new Router()
  router.addRoute('test.limited', async () => 'ok', { rateLimit: { tokensPerMin: 1, burst: 1 } })
  await router.start()

  // No remotePubkey = no rate limiting
  const r1 = await router.dispatch('test.limited', {}, {})
  t.is(r1, 'ok')
  const r2 = await router.dispatch('test.limited', {}, {})
  t.is(r2, 'ok')

  await router.stop()
})

test('Router - orchestrate executes steps sequentially', async (t) => {
  const router = new Router()
  const order = []

  router.addRoute('step.a', async (params) => {
    order.push('a')
    return { value: 10 }
  })
  router.addRoute('step.b', async (params) => {
    order.push('b')
    return { value: params.input + 5 }
  })
  router.addRoute('step.c', async (params) => {
    order.push('c')
    return { value: params.input * 2 }
  })

  await router.start()

  const results = await router.orchestrate([
    { route: 'step.a', params: {}, as: 'first' },
    { route: 'step.b', params: (prev) => ({ input: prev.first.value }), as: 'second' },
    { route: 'step.c', params: (prev) => ({ input: prev.second.value }), as: 'third' }
  ])

  t.alike(order, ['a', 'b', 'c'])
  t.is(results.first.value, 10)
  t.is(results.second.value, 15)
  t.is(results.third.value, 30)

  await router.stop()
})

test('Router - orchestrate rolls back on failure', async (t) => {
  const router = new Router()
  const rolledBack = []

  router.addRoute('step.ok', async () => ({ done: true }))
  router.addRoute('step.fail', async () => { throw new Error('BOOM') })

  await router.start()

  try {
    await router.orchestrate([
      {
        route: 'step.ok',
        params: {},
        as: 'first',
        rollback: async (results, err) => { rolledBack.push('first') }
      },
      { route: 'step.fail', params: {}, as: 'second' }
    ])
    t.fail('should throw')
  } catch (err) {
    t.is(err.message, 'BOOM')
    t.is(err.failedStep, 'step.fail')
    t.ok(err.traceId)
    t.is(rolledBack.length, 1)
    t.is(rolledBack[0], 'first')
  }

  await router.stop()
})

test('Router - orchestrate shares traceId across steps', async (t) => {
  const router = new Router()
  const traceIds = []

  router.addRoute('step.trace', async (params, ctx) => {
    traceIds.push(ctx.traceId)
    return {}
  })

  await router.start()

  await router.orchestrate([
    { route: 'step.trace', params: {} },
    { route: 'step.trace', params: {} },
    { route: 'step.trace', params: {} }
  ])

  t.is(traceIds.length, 3)
  t.is(traceIds[0], traceIds[1])
  t.is(traceIds[1], traceIds[2])

  await router.stop()
})

test('Router - getStats shows named pools', async (t) => {
  const router = new Router()
  await router.start()

  const stats = router.getStats()
  t.ok(stats.workerPools)
  t.is(typeof stats.workerPools, 'object')

  await router.stop()
})
