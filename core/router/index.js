/**
 * Fast Application-Layer Router
 *
 * O(1) dispatch via Map-based route table. Unifies P2P and HTTP transports
 * through a single dispatch path. Optionally offloads heavy work to a
 * worker thread pool.
 *
 * Route key format: "service.method" (e.g., "storage.drive-read")
 */

import crypto from 'crypto'
import { EventEmitter } from 'events'
import { PubSub } from './pubsub.js'
import { WorkerPool } from './worker-pool.js'

const ROUTE_ACCESS_POLICIES = {
  // Identity
  'identity.whoami': 'public',
  'identity.resolve': 'public',
  'identity.developer': 'public',
  'identity.peers': 'authenticated-user',
  'identity.sign': 'local-only',
  'identity.verify': 'local-only',

  // AI
  'ai.list-models': 'public',
  'ai.status': 'public',
  'ai.infer': 'authenticated-user',
  'ai.embed': 'authenticated-user',
  'ai.register-model': 'relay-admin',
  'ai.remove-model': 'relay-admin',

  // Compute
  'compute.capabilities': 'public',
  'compute.submit': 'authenticated-user',
  'compute.status': 'authenticated-user',
  'compute.result': 'authenticated-user',
  'compute.cancel': 'authenticated-user',
  'compute.list': 'relay-admin',

  // Storage
  'storage.drive-create': 'authenticated-user',
  'storage.drive-list': 'authenticated-user',
  'storage.drive-get': 'authenticated-user',
  'storage.drive-read': 'authenticated-user',
  'storage.drive-write': 'authenticated-user',
  'storage.drive-delete': 'authenticated-user',
  'storage.core-create': 'authenticated-user',
  'storage.core-append': 'authenticated-user',
  'storage.core-get': 'authenticated-user',

  // Schema
  'schema.get': 'public',
  'schema.list': 'public',
  'schema.versions': 'public',
  'schema.register': 'authenticated-user',
  'schema.validate': 'authenticated-user',

  // SLA
  'sla.stats': 'public',
  'sla.create': 'authenticated-user',
  'sla.get': 'authenticated-user',
  'sla.list': 'relay-admin',
  'sla.check': 'relay-admin',
  'sla.violations': 'relay-admin',
  'sla.terminate': 'relay-admin',

  // Arbitration
  'arbitration.submit': 'authenticated-user',
  'arbitration.vote': 'authenticated-user',
  'arbitration.get': 'authenticated-user',
  'arbitration.list': 'relay-admin',
  'arbitration.evidence': 'relay-admin'
}

const SERVICE_DEFAULT_ACCESS = {
  storage: 'authenticated-user',
  compute: 'authenticated-user',
  ai: 'authenticated-user',
  schema: 'authenticated-user',
  sla: 'authenticated-user',
  arbitration: 'authenticated-user',
  zk: 'authenticated-user',
  identity: 'authenticated-user'
}

export class Router extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._routes = new Map() // route key -> RouteEntry
    this._registry = opts.registry || null
    this._middleware = opts.middleware || [] // global middleware
    this._workerPools = new Map() // pool name -> WorkerPool
    this._workerConfig = opts.workerPools || {} // { cpu: { size: N }, io: { size: N } }
    // Backward compat: opts.workers creates a 'cpu' pool
    if (opts.workers && !opts.workerPools) {
      this._workerConfig = { cpu: { size: opts.workers } }
    }
    this._workerScript = opts.workerScript ?? new URL('./worker.js', import.meta.url)
    this._rateLimiters = new Map() // "route:peerKey" -> { tokens, lastRefill }
    this.pubsub = new PubSub(opts.pubsub)
    this._started = false
  }

  /**
   * Register a route with an in-process handler.
   *
   * @param {string} key - Route key, e.g. "storage.drive-read"
   * @param {Function} handler - async (params, context) => result
   * @param {object} [opts]
   * @param {boolean} [opts.worker] - Offload to worker pool
   * @param {string} [opts.workerTask] - Worker task type (defaults to key)
   * @param {number} [opts.timeout] - Per-route timeout in ms
   * @param {number} [opts.maxPayloadBytes] - Max request payload size
   * @param {Function[]} [opts.middleware] - Per-route middleware
   */
  addRoute (key, handler, opts = {}) {
    this._routes.set(key, {
      key,
      handler,
      workerTask: opts.worker ? (opts.workerTask || key) : null,
      workerPool: opts.pool || 'cpu', // Named pool: 'cpu' (default) or 'io'
      middleware: opts.middleware || [],
      timeout: opts.timeout || 30_000,
      maxPayloadBytes: opts.maxPayloadBytes || 0,
      access: opts.access || 'public', // public | authenticated-user | relay-admin | local-only
      rateLimit: opts.rateLimit || null // { tokensPerMin, burst }
    })
  }

  removeRoute (key) {
    this._routes.delete(key)
  }

  /**
   * Add a global middleware function.
   * Middleware runs before every route handler.
   */
  addMiddleware (fn) {
    this._middleware.push(fn)
  }

  /**
   * Auto-generate routes from a ServiceRegistry.
   * For each service, creates a route for each capability in its manifest.
   */
  registerFromRegistry (registry) {
    if (!registry) return

    for (const [name, entry] of registry.services) {
      const manifest = entry.provider.manifest()
      if (!manifest.capabilities) continue

      for (const method of manifest.capabilities) {
        const key = `${name}.${method}`
        const provider = entry.provider
        const access = ROUTE_ACCESS_POLICIES[key] || SERVICE_DEFAULT_ACCESS[name] || 'authenticated-user'
        // Bind the method if it exists on the provider
        if (typeof provider[method] === 'function') {
          this.addRoute(key, (params, ctx) => provider[method](params, ctx), { access })
        }
      }
    }
  }

  /**
   * Core dispatch — the hot path.
   *
   * 1. Map.get(route) — O(1)
   * 2. Run middleware (typically 0-2 functions)
   * 3. Call handler or offload to worker
   *
   * Falls back to ServiceRegistry if route not found.
   */
  async dispatch (route, params = {}, context = {}) {
    // Inject trace ID for observability
    if (!context.traceId) {
      context.traceId = crypto.randomBytes(8).toString('hex')
    }

    const entry = this._routes.get(route)

    if (entry) {
      if (!this._isAuthorized(entry.access, context)) {
        throw new Error(`ACCESS_DENIED: route requires ${entry.access}`)
      }

      // Per-route rate limiting
      if (entry.rateLimit && context.remotePubkey) {
        if (!this._checkRateLimit(route, context.remotePubkey, entry.rateLimit)) {
          throw new Error('RATE_LIMITED')
        }
      }

      // Run global middleware, then route-specific middleware
      const allMiddleware = this._middleware.concat(entry.middleware)
      for (const mw of allMiddleware) {
        const result = await mw(route, params, context)
        if (result === false) throw new Error('MIDDLEWARE_REJECTED')
        if (result && typeof result === 'object') {
          if (result.params) params = result.params
          if (result.context) context = { ...context, ...result.context }
        }
      }

      // Worker offload path — route to named pool
      if (entry.workerTask) {
        const pool = this._workerPools.get(entry.workerPool)
        if (pool && pool.started) {
          return pool.run(entry.workerTask, params, { timeout: entry.timeout })
        }
      }

      // In-process hot path
      return entry.handler(params, context)
    }

    // Fallback: delegate to registry for backward compat
    if (this._registry) {
      const dotIdx = route.indexOf('.')
      if (dotIdx > 0) {
        const service = route.slice(0, dotIdx)
        const method = route.slice(dotIdx + 1)
        return this._registry.handleRequest(service, method, params, context)
      }
    }

    throw new Error(`ROUTE_NOT_FOUND: ${route}`)
  }

  _isAuthorized (required, context = {}) {
    const role = context.role || null

    if (!required || required === 'public') return true

    if (required === 'authenticated-user') {
      return context.authenticated === true || role === 'authenticated-user' || role === 'relay-admin' || role === 'local'
    }

    if (required === 'relay-admin') {
      return role === 'relay-admin' || role === 'local'
    }

    if (required === 'local-only') {
      return role === 'local' || context.caller === 'local'
    }

    return false
  }

  /**
   * Orchestrate a multi-step transaction across services.
   * Executes steps sequentially, passing accumulated results to each next step.
   * If any step fails, calls rollback handlers in reverse order.
   *
   * @param {Array} steps - [{ route, params (object or function), as, rollback? }]
   * @param {object} [context]
   * @returns {object} Accumulated results keyed by each step's `as` field
   */
  async orchestrate (steps, context = {}) {
    const traceId = crypto.randomBytes(8).toString('hex')
    const ctx = { ...context, traceId }
    const results = {}
    const completed = []

    for (const step of steps) {
      const stepParams = typeof step.params === 'function'
        ? step.params(results)
        : (step.params || {})

      try {
        const result = await this.dispatch(step.route, stepParams, ctx)
        if (step.as) results[step.as] = result
        completed.push(step)
      } catch (err) {
        // Rollback completed steps in reverse order
        for (let i = completed.length - 1; i >= 0; i--) {
          const done = completed[i]
          if (typeof done.rollback === 'function') {
            try { await done.rollback(results, err) } catch {}
          }
        }
        err.traceId = traceId
        err.failedStep = step.route
        throw err
      }
    }

    return results
  }

  /**
   * Get all registered route keys.
   */
  routes () {
    return [...this._routes.keys()]
  }

  getRouteAccess (route) {
    const entry = this._routes.get(route)
    return entry ? entry.access : null
  }

  /**
   * Get stats about the router.
   */
  getStats () {
    return {
      routes: this._routes.size,
      pubsub: {
        topics: this.pubsub.topicCount(),
        subscribers: this.pubsub.subscriberCount()
      },
      workerPools: Object.fromEntries(
        [...this._workerPools.entries()].map(([name, pool]) => [name, pool.getStats()])
      )
    }
  }

  /**
   * Per-route, per-peer token bucket rate limiting.
   */
  _checkRateLimit (route, peerKey, config) {
    const key = `${route}:${peerKey}`
    const now = Date.now()
    let bucket = this._rateLimiters.get(key)

    if (!bucket) {
      bucket = { tokens: config.burst || config.tokensPerMin, lastRefill: now }
      this._rateLimiters.set(key, bucket)
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 60_000 // minutes
    bucket.tokens = Math.min(
      config.burst || config.tokensPerMin,
      bucket.tokens + elapsed * config.tokensPerMin
    )
    bucket.lastRefill = now

    if (bucket.tokens < 1) return false
    bucket.tokens--
    return true
  }

  async start () {
    if (this._started) return

    // Start named worker pools
    for (const [name, config] of Object.entries(this._workerConfig)) {
      if (config.size > 0) {
        const pool = new WorkerPool({
          size: config.size,
          workerScript: config.workerScript || this._workerScript,
          taskTimeout: config.taskTimeout
        })
        await pool.start()
        this._workerPools.set(name, pool)
      }
    }

    // Periodic cleanup of stale rate limit buckets (every 5 min)
    this._rateLimitCleanup = setInterval(() => {
      const cutoff = Date.now() - 5 * 60_000
      for (const [key, bucket] of this._rateLimiters) {
        if (bucket.lastRefill < cutoff) this._rateLimiters.delete(key)
      }
    }, 5 * 60_000)
    if (this._rateLimitCleanup.unref) this._rateLimitCleanup.unref()

    this._started = true
    this.emit('started', { routes: this._routes.size, pools: [...this._workerPools.keys()] })
  }

  async stop () {
    if (!this._started) return

    // Stop all worker pools
    for (const [, pool] of this._workerPools) {
      await pool.stop()
    }
    this._workerPools.clear()
    if (this._rateLimitCleanup) { clearInterval(this._rateLimitCleanup); this._rateLimitCleanup = null }
    this._rateLimiters.clear()

    this.pubsub.destroy()
    this._routes.clear()
    this._started = false
    this.emit('stopped')
  }
}
