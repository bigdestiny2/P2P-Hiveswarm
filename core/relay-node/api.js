/**
 * Local HTTP API for agent integration
 *
 * Lightweight REST API using Node.js built-in http module.
 * Enables agents (Hermes, OpenClaw) to query and control the relay
 * node without importing the module directly.
 *
 * Security features:
 *   - Configurable bind address (opts.apiHost, default '0.0.0.0')
 *   - Configurable CORS origins (opts.corsOrigins, default deny)
 *   - Per-IP rate limiting to prevent abuse
 *   - Hex key input validation on all POST routes
 */

import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { EventEmitter } from 'events'
import { DashboardFeed } from './ws-feed.js'
import { HyperGateway } from '../../compute/gateway/hyper-gateway.js'
import { isValidHexKey, normalizePrivacyTier } from '../constants.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_PORT = 9100

// Rate limit: 60 requests per minute per IP
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

const MAX_DISCOVERY_KEYS = 100
const PRIVACY_TIER_ERROR = 'privacyTier must be one of: public, local-first, p2p-only'
const MANAGEMENT_AUTH_ERROR = 'Unauthorized — management API requires API key or localhost access'
const LOCAL_ONLY_DISPATCH_ROUTES = new Set([
  'identity.sign',
  'identity.verify'
])
const AVAILABLE_MODES = [
  'public',
  'standard',
  'private',
  'hybrid',
  'homehive',
  'seed-only',
  'relay-only',
  'stealth',
  'gateway'
]

export class RelayAPI extends EventEmitter {
  constructor (relayNode, opts = {}) {
    super()
    this.node = relayNode
    this.port = opts.apiPort || DEFAULT_PORT
    this.host = opts.apiHost || '0.0.0.0'
    this.corsOrigins = opts.corsOrigins || []
    this.server = null

    // API key for authenticated endpoints (manage, seed, unseed)
    // Read from opts, env var, or generate a random one
    this._apiKey = opts.apiKey || process.env.HIVERELAY_API_KEY || null

    // Per-IP request counts: ip -> { count, resetAt }
    this._rateLimits = new Map()
    this._rateLimitCleanup = null
    this._dashboardHtml = null
    this._networkHtml = null
    this._docsHtml = null
    this._dashboardFeed = null
    this._gateway = new HyperGateway(relayNode, { store: relayNode.store })
  }

  async start () {
    this.server = createServer((req, res) => this._handle(req, res))

    // Clean stale rate limit entries every 2 minutes
    this._rateLimitCleanup = setInterval(() => {
      const now = Date.now()
      for (const [ip, entry] of this._rateLimits) {
        if (now > entry.resetAt) this._rateLimits.delete(ip)
      }
    }, 120_000)

    return new Promise((resolve, reject) => {
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        // Start WebSocket live feed for dashboard clients
        this._dashboardFeed = new DashboardFeed({
          server: this.server,
          node: this.node,
          corsOrigins: this.corsOrigins,
          apiKey: this._apiKey
        })
        this._dashboardFeed.start()

        this.emit('started', { port: this.port })
        resolve()
      })
    })
  }

  _checkRateLimit (ip) {
    const now = Date.now()
    let entry = this._rateLimits.get(ip)

    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
      this._rateLimits.set(ip, entry)
    }

    entry.count++
    return entry.count <= RATE_LIMIT_MAX
  }

  /**
   * Check if the request has a valid API key.
   * Checks Authorization: Bearer <key> header.
   * If no API key is configured, management endpoints are localhost-only.
   */
  _checkAuth (req) {
    // If API key is configured, require it
    if (this._apiKey) {
      const auth = req.headers.authorization || ''
      if (auth === 'Bearer ' + this._apiKey) return true
      return false
    }

    // No API key configured — restrict to localhost only
    return this._isLocalRequest(req)
  }

  _isLocalRequest (req) {
    const ip = req.socket.remoteAddress || ''
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }

  _requireAuth (req, res, errorMessage) {
    if (this._checkAuth(req)) return true
    this._json(res, { error: errorMessage }, 401)
    return false
  }

  _readPrivacyTier (value, fallback = 'public') {
    return normalizePrivacyTier(value, fallback)
  }

  async _handle (req, res) {
    const ip = req.socket.remoteAddress || '127.0.0.1'
    const requestOrigin = req.headers.origin

    // CORS headers on all responses
    const allowedOrigin = this._getAllowedOrigin(requestOrigin)
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      if (requestOrigin && !allowedOrigin) {
        return this._json(res, { error: 'CORS origin denied' }, 403)
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.writeHead(204)
      res.end()
      return
    }

    // Rate limit check
    if (!this._checkRateLimit(ip)) {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Retry-After', '60')
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'Too many requests' }) + '\n')
      return
    }

    const url = new URL(req.url, `http://0.0.0.0:${this.port}`)
    const path = url.pathname

    res.setHeader('Content-Type', 'application/json')

    try {
      // Hyper Gateway — serve Hyperdrive content over HTTP
      if (path.startsWith('/v1/hyper/')) {
        return this._gateway.handle(req, res)
      }

      // Gateway stats endpoint
      if (req.method === 'GET' && path === '/api/gateway') {
        return this._json(res, this._gateway.getStats())
      }

      // Catalog endpoint — lists all seeded drives as an app catalog
      // PearBrowser can use this as a catalog source
      // Deduplicated by appId — only shows the latest version of each app
      if (req.method === 'GET' && path === '/catalog.json') {
        const page = parseInt(url.searchParams.get('page')) || 1
        const pageSize = Math.min(parseInt(url.searchParams.get('pageSize')) || 50, 500)
        const apps = this.node.appRegistry.catalog()
        const total = apps.length
        const start = (page - 1) * pageSize
        const paged = apps.slice(start, start + pageSize)

        res.setHeader('Content-Type', 'application/json')
        return this._json(res, {
          version: 1,
          name: 'HiveRelay App Catalog',
          relayKey: this.node.swarm
            ? Buffer.from(this.node.swarm.keyPair.publicKey).toString('hex')
            : null,
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            hasNext: start + pageSize < total,
            hasPrev: page > 1
          },
          apps: paged
        })
      }

      // GET routes
      if (req.method === 'GET') {
        if (path === '/health') {
          return this._json(res, {
            ok: true,
            uptime: this.node.metrics ? this.node.metrics.getSummary().uptime : null,
            running: this.node.running
          })
        }

        if (path === '/status') {
          return this._json(res, this.node.getStats())
        }

        if (path === '/metrics') {
          if (this.node.metrics) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8')
            res.writeHead(200)
            res.end(this.node.metrics.toPrometheus())
            return
          }
          return this._json(res, { error: 'Metrics not enabled' }, 503)
        }

        if (path === '/peers') {
          const peers = []
          if (this.node.swarm) {
            for (const conn of this.node.swarm.connections) {
              peers.push({
                remotePublicKey: conn.remotePublicKey ? Buffer.from(conn.remotePublicKey).toString('hex') : null
              })
            }
          }
          return this._json(res, { count: peers.length, peers })
        }

        // --- Dashboard endpoints ---

        if (path === '/dashboard') {
          if (!this._dashboardHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'index.html')
            this._dashboardHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._dashboardHtml)
          return
        }

        if (path === '/network') {
          if (!this._networkHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'network.html')
            this._networkHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._networkHtml)
          return
        }

        if (path === '/docs') {
          if (!this._docsHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'docs.html')
            this._docsHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._docsHtml)
          return
        }

        if (path === '/api/health-detail') {
          const healthStatus = this.node.getHealthStatus()
          const actions = this.node.selfHeal ? this.node.selfHeal.getActions() : []
          return this._json(res, { ...healthStatus, actions })
        }

        if (path === '/api/overview') {
          const stats = this.node.getStats()
          const mem = process.memoryUsage()
          const uptimeMs = this.node.metrics ? Date.now() - this.node.metrics.startedAt : 0
          const hours = Math.round(uptimeMs / 3600000 * 100) / 100
          const days = Math.floor(uptimeMs / 86400000)
          const h = Math.floor((uptimeMs % 86400000) / 3600000)
          const m = Math.floor((uptimeMs % 3600000) / 60000)
          const parts = []
          if (days > 0) parts.push(`${days}d`)
          if (h > 0) parts.push(`${h}h`)
          parts.push(`${m}m`)

          const config = this.node.config || {}
          const maxStorage = config.maxStorageBytes || 5368709120
          const bytesStored = stats.seeder ? stats.seeder.totalBytesStored : 0
          const reputationSummary = this.node.reputation
            ? {
                trackedRelays: Object.keys(this.node.reputation.export()).length,
                topRelay: (() => {
                  const lb = this.node.reputation.getLeaderboard(1)
                  return lb.length ? lb[0] : null
                })()
              }
            : null
          const bandwidthSummary = this.node._bandwidthReceipt
            ? {
                totalProvenBytes: this.node._bandwidthReceipt.getTotalProvenBandwidth(),
                receiptsIssued: this.node._bandwidthReceipt._issuedReceipts ? this.node._bandwidthReceipt._issuedReceipts.length : 0
              }
            : null
          const registrySummary = this.node.seedingRegistry
            ? {
                running: this.node.seedingRegistry.running,
                autoAccept: this.node.config.registryAutoAccept !== false
              }
            : null
          const gatewayStats = this._gateway ? this._gateway.getStats() : null

          return this._json(res, {
            uptime: { ms: uptimeMs, hours, human: parts.join(' ') },
            publicKey: stats.publicKey,
            region: (config.regions && config.regions[0]) || null,
            connections: stats.connections,
            seededApps: stats.seededApps,
            storage: {
              used: bytesStored,
              max: maxStorage,
              pct: maxStorage > 0 ? Math.round(bytesStored / maxStorage * 10000) / 10000 : 0
            },
            relay: stats.relay || { activeCircuits: 0, totalCircuitsServed: 0, totalBytesRelayed: 0 },
            seeder: stats.seeder || { coresSeeded: 0, totalBytesStored: 0, totalBytesServed: 0 },
            memory: { heapUsed: mem.heapUsed, rss: mem.rss },
            errors: this.node.metrics ? this.node.metrics._errorCount : 0,
            reputation: reputationSummary,
            tor: this.node.torTransport ? this.node.torTransport.getInfo() : null,
            holesailKey: this.node.holesailTransport ? this.node.holesailTransport.connectionKey : null,
            health: this.node.getHealthStatus(),
            bandwidth: bandwidthSummary,
            registry: registrySummary,
            gateway: gatewayStats
          })
        }

        if (path === '/api/history') {
          if (!this.node.metrics) {
            return this._json(res, { error: 'Metrics not enabled' }, 503)
          }
          const minutes = parseInt(url.searchParams.get('minutes')) || 60
          const cutoff = Date.now() - (minutes * 60_000)
          const snapshots = this.node.metrics.snapshots
            .filter(s => s.timestamp >= cutoff)
          return this._json(res, snapshots)
        }

        if (path === '/api/apps') {
          const apps = []
          const now = Date.now()
          for (const [appKey, entry] of this.node.seededApps) {
            apps.push({
              appKey,
              appId: entry.appId || null,
              version: entry.version || null,
              discoveryKey: entry.discoveryKey ? (typeof entry.discoveryKey === 'string' ? entry.discoveryKey : Buffer.from(entry.discoveryKey).toString('hex')) : null,
              startedAt: entry.startedAt,
              bytesServed: entry.bytesServed || 0,
              uptimeMinutes: Math.round((now - entry.startedAt) / 60_000)
            })
          }
          return this._json(res, apps)
        }

        if (path === '/api/peers') {
          const peers = []
          const now = Date.now()
          if (this.node.swarm) {
            for (const conn of this.node.swarm.connections) {
              const entry = this.node.connections.get(conn)
              const peerPubkey = conn.remotePublicKey ? Buffer.from(conn.remotePublicKey).toString('hex') : null
              const peerData = {
                remotePublicKey: peerPubkey,
                type: conn.type || null,
                connectedFor: entry ? now - entry.lastActivity : null
              }
              if (peerPubkey && this.node.reputation) {
                const record = this.node.reputation.getRecord(peerPubkey)
                peerData.reputation = record || null
              }
              peers.push(peerData)
            }
          }
          return this._json(res, { count: peers.length, peers })
        }

        if (path === '/api/network') {
          if (!this.node.networkDiscovery) {
            return this._json(res, { error: 'Network discovery not running' }, 503)
          }
          return this._json(res, this.node.networkDiscovery.getNetworkState())
        }

        if (path === '/api/registry/pending') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/registry/pending')) return
          const pending = []
          for (const [appKey, entry] of this.node._pendingRequests) {
            pending.push({ appKey, ...entry })
          }
          return this._json(res, { count: pending.length, requests: pending })
        }

        if (path === '/api/registry') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/registry')) return
          if (!this.node.seedingRegistry) {
            return this._json(res, { error: 'Registry not running' }, 503)
          }
          const requests = await this.node.seedingRegistry.getActiveRequests()
          const enriched = []
          for (const req of requests) {
            const relays = await this.node.seedingRegistry.getRelaysForApp(req.appKey)
            enriched.push({
              ...req,
              acceptedRelays: relays.length,
              relays: relays.map(r => ({ pubkey: r.relayPubkey, region: r.region }))
            })
          }
          return this._json(res, {
            key: this.node.seedingRegistry.key
              ? Buffer.from(this.node.seedingRegistry.key).toString('hex')
              : null,
            activeRequests: enriched.length,
            requests: enriched
          })
        }

        if (path === '/api/reputation') {
          const leaderboard = this.node.reputation ? this.node.reputation.getLeaderboard(100) : []
          return this._json(res, leaderboard)
        }

        if (path.startsWith('/api/reputation/')) {
          const pubkey = path.slice('/api/reputation/'.length)
          if (!this.node.reputation) return this._json(res, null)
          const record = this.node.reputation.getRecord(pubkey)
          return this._json(res, record)
        }
      }

      // ─── Services & Router ───
      if (req.method === 'GET' && path === '/api/v1/services') {
        if (!this.node.serviceRegistry) {
          return this._json(res, { error: 'Services not enabled' }, 503)
        }
        return this._json(res, {
          services: this.node.serviceRegistry.catalog(),
          count: this.node.serviceRegistry.services.size
        })
      }

      if (req.method === 'GET' && path === '/api/v1/router') {
        if (!this.node.router) {
          return this._json(res, { error: 'Router not enabled' }, 503)
        }
        const pubsubInfo = this.node.router.pubsub
          ? {
              topics: this.node.router.pubsub.topics?.() || []
            }
          : null
        return this._json(res, {
          routes: this.node.router.routes().length,
          pubsub: pubsubInfo
        })
      }

      // ─── Content-Type validation for POST requests ─────────────────
      if (req.method === 'POST') {
        const contentType = req.headers['content-type'] || ''
        const contentLength = req.headers['content-length']
        const isEmptyBody = contentLength === '0' || contentLength === undefined
        if (contentType && !contentType.includes('application/json')) {
          return this._json(res, { error: 'Content-Type must be application/json' }, 400)
        }
        if (!contentType && !isEmptyBody) {
          return this._json(res, { error: 'Content-Type must be application/json' }, 400)
        }
      }

      if (req.method === 'POST' && path === '/api/v1/dispatch') {
        if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/v1/dispatch')) return
        if (!this.node.router) {
          return this._json(res, { error: 'Router not enabled' }, 503)
        }
        const body = await this._readBody(req)
        if (!body.route || typeof body.route !== 'string') {
          return this._json(res, { error: 'route required (e.g. "ai.infer", "zk.commit")' }, 400)
        }

        const isLocalRequest = this._isLocalRequest(req)
        if (LOCAL_ONLY_DISPATCH_ROUTES.has(body.route) && !isLocalRequest) {
          return this._json(res, { error: `ACCESS_DENIED: ${body.route} is local-only` }, 403)
        }

        const routeAccess = this.node.router.getRouteAccess
          ? this.node.router.getRouteAccess(body.route)
          : null
        const routeRole = isLocalRequest
          ? 'local'
          : (routeAccess === 'relay-admin' ? 'relay-admin' : 'authenticated-user')
        try {
          const result = await this.node.router.dispatch(body.route, body.params || {}, {
            transport: 'http',
            caller: 'remote',
            role: routeRole,
            authenticated: true
          })
          return this._json(res, { ok: true, result })
        } catch (err) {
          return this._json(res, { error: err.message }, 400)
        }
      }

      // POST routes
      if (req.method === 'POST') {
        const body = await this._readBody(req)

        if (path === '/seed') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /seed')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          const seedOpts = body.opts || {}
          // Forward appId from request body for deduplication
          if (body.appId && typeof body.appId === 'string') seedOpts.appId = body.appId
          if (body.version && typeof body.version === 'string') seedOpts.version = body.version
          if (body.name !== undefined) {
            if (typeof body.name !== 'string') return this._json(res, { error: 'name must be a string' }, 400)
            seedOpts.name = body.name.trim().slice(0, 120)
          }
          if (body.description !== undefined) {
            if (typeof body.description !== 'string') return this._json(res, { error: 'description must be a string' }, 400)
            seedOpts.description = body.description.slice(0, 2000)
          }
          if (body.author !== undefined) {
            if (typeof body.author !== 'string') return this._json(res, { error: 'author must be a string' }, 400)
            seedOpts.author = body.author.trim().slice(0, 120)
          }
          if (body.categories !== undefined) {
            if (!Array.isArray(body.categories)) return this._json(res, { error: 'categories must be an array of strings' }, 400)
            const categories = []
            for (const category of body.categories) {
              if (typeof category !== 'string') return this._json(res, { error: 'categories must be an array of strings' }, 400)
              const normalized = category.trim()
              if (!normalized) continue
              categories.push(normalized.slice(0, 64))
            }
            seedOpts.categories = [...new Set(categories)].slice(0, 20)
          }
          if (body.privacyTier !== undefined) {
            const tier = this._readPrivacyTier(body.privacyTier, null)
            if (!tier) return this._json(res, { error: PRIVACY_TIER_ERROR }, 400)
            seedOpts.privacyTier = tier
          }
          const result = await this.node.seedApp(body.appKey, seedOpts)
          return this._json(res, { ok: true, ...result })
        }

        if (path === '/registry/publish') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /registry/publish')) return
          if (!this.node.seedingRegistry) return this._json(res, { error: 'Registry not running' }, 503)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)

          const dks = body.discoveryKeys || []
          if (!Array.isArray(dks) || dks.length > MAX_DISCOVERY_KEYS) {
            return this._json(res, { error: `discoveryKeys must be an array of at most ${MAX_DISCOVERY_KEYS} items` }, 400)
          }
          for (const dk of dks) {
            if (!isValidHexKey(dk, 64)) return this._json(res, { error: 'Each discoveryKey must be 64 hex characters' }, 400)
          }

          const privacyTier = body.privacyTier === undefined
            ? 'public'
            : this._readPrivacyTier(body.privacyTier, null)
          if (!privacyTier) return this._json(res, { error: PRIVACY_TIER_ERROR }, 400)

          let appKeyBuf, dkBufs
          try {
            appKeyBuf = Buffer.from(body.appKey, 'hex')
            dkBufs = dks.map(dk => Buffer.from(dk, 'hex'))
          } catch (err) {
            return this._json(res, { error: 'Invalid hex encoding: ' + err.message }, 400)
          }

          const request = {
            appKey: appKeyBuf,
            discoveryKeys: dkBufs,
            replicationFactor: body.replicas || 3,
            geoPreference: body.geo ? [].concat(body.geo) : [],
            maxStorageBytes: body.maxStorageBytes || 0,
            bountyRate: body.bountyRate || 0,
            ttlSeconds: body.ttlDays ? body.ttlDays * 86400 : 30 * 86400,
            privacyTier,
            publisherPubkey: this.node.swarm ? this.node.swarm.keyPair.publicKey : Buffer.alloc(32)
          }

          const entry = await this.node.seedingRegistry.publishRequest(request)
          return this._json(res, { ok: true, ...entry })
        }

        if (path === '/registry/auto-accept') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /registry/auto-accept')) return
          this.node.config.registryAutoAccept = body.enabled !== false
          return this._json(res, { ok: true, autoAccept: this.node.config.registryAutoAccept })
        }

        if (path === '/registry/approve') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /registry/approve')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          await this.node.approveRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/registry/reject') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /registry/reject')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          this.node.rejectRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/registry/cancel') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /registry/cancel')) return
          if (!this.node.seedingRegistry) return this._json(res, { error: 'Registry not running' }, 503)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          const pubkey = this.node.swarm ? Buffer.from(this.node.swarm.keyPair.publicKey).toString('hex') : null
          await this.node.seedingRegistry.cancelRequest(body.appKey, pubkey)
          return this._json(res, { ok: true })
        }

        if (path === '/unseed') {
          // Operator unseed — requires API key (use /api/v1/unseed for developer-signed unseed)
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /unseed (use /api/v1/unseed for developer-signed unseed)')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          await this.node.unseedApp(body.appKey)
          return this._json(res, { ok: true })
        }

        // ─── Developer Authenticated Unseed (Kill Switch) ───────────
        if (path === '/api/v1/unseed') {
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          if (!body.publisherPubkey) return this._json(res, { error: 'publisherPubkey required' }, 400)
          if (!isValidHexKey(body.publisherPubkey, 64)) return this._json(res, { error: 'publisherPubkey must be 64 hex characters' }, 400)
          if (!body.signature) return this._json(res, { error: 'signature required' }, 400)
          if (!isValidHexKey(body.signature, 128)) return this._json(res, { error: 'signature must be 128 hex characters' }, 400)
          if (!body.timestamp || typeof body.timestamp !== 'number') return this._json(res, { error: 'timestamp required (unix ms)' }, 400)

          const result = this.node.verifyUnseedRequest(body.appKey, body.publisherPubkey, body.signature, body.timestamp)
          if (!result.ok) {
            return this._json(res, { error: result.error }, 403)
          }

          await this.node.unseedApp(body.appKey)

          // Propagate unseed to other relays via P2P
          this.node.broadcastUnseed(body.appKey, body.publisherPubkey, body.signature, body.timestamp)

          return this._json(res, { ok: true, message: 'App unseeded and unseed broadcast to network' })
        }

        // ─── Live Management API (requires API key or localhost) ─────

        if (path.startsWith('/api/manage/')) {
          if (!this._requireAuth(req, res, MANAGEMENT_AUTH_ERROR)) return
        }

        if (path === '/api/manage/config') {
          return this._handleConfigUpdate(res, body)
        }

        if (path === '/api/manage/services') {
          return this._handleServiceManagement(res, body)
        }

        if (path === '/api/manage/mode') {
          return this._handleModeSwitch(res, body)
        }

        if (path === '/api/manage/devices') {
          return this._handleDeviceManagement(res, body)
        }

        if (path === '/api/manage/pairing') {
          return this._handlePairingManagement(res, body)
        }

        if (path === '/api/manage/transport') {
          return this._handleTransportToggle(res, body)
        }

        if (path === '/api/manage/restart') {
          this._json(res, { ok: true, message: 'Restarting node...' })
          setTimeout(async () => {
            try {
              await this.node.stop()
              await this.node.start()
            } catch (err) {
              this.emit('error', { context: 'restart', error: err })
            }
          }, 500)
          return
        }

        if (path === '/api/manage/shutdown') {
          this._json(res, { ok: true, message: 'Shutting down...' })
          setTimeout(async () => {
            try {
              await this.node.stop()
              process.exit(0)
            } catch (_) {
              process.exit(1)
            }
          }, 500)
          return
        }
      }

      // GET — Management info endpoints (require auth)
      if (req.method === 'GET') {
        if (path.startsWith('/api/manage/') && !this._requireAuth(req, res, MANAGEMENT_AUTH_ERROR)) return

        if (path === '/api/manage/config') {
          return this._json(res, {
            config: this._getSafeConfig(),
            mode: this.node._operatingMode || 'standard'
          })
        }

        if (path === '/api/manage/services') {
          if (!this.node.serviceRegistry) {
            return this._json(res, { services: [], count: 0 })
          }
          const services = []
          for (const [name, provider] of this.node.serviceRegistry.services) {
            services.push({
              name,
              running: provider.running || false,
              methods: provider.methods
                ? Object.keys(provider.methods)
                : [],
              stats: provider.stats
                ? provider.stats()
                : null
            })
          }
          return this._json(res, { services, count: services.length })
        }

        if (path === '/api/manage/transports') {
          return this._json(res, {
            udp: true,
            holesail: {
              enabled: !!this.node.holesailTransport,
              connectionKey: this.node.holesailTransport
                ? this.node.holesailTransport.connectionKey
                : null,
              running: this.node.holesailTransport
                ? this.node.holesailTransport.running
                : false
            },
            tor: {
              enabled: !!this.node.torTransport,
              onionAddress: this.node.torTransport
                ? this.node.torTransport.onionAddress
                : null,
              running: this.node.torTransport
                ? this.node.torTransport.running
                : false
            },
            websocket: {
              enabled: !!(this.node.config.transports && this.node.config.transports.websocket),
              port: this.node.config.wsPort || 8765
            }
          })
        }

        if (path === '/api/manage/devices') {
          if (!this.node.accessControl) {
            return this._json(res, {
              enabled: false,
              mode: this.node.mode,
              devices: []
            })
          }
          const devices = this.node.listDevices()
          return this._json(res, {
            enabled: true,
            mode: this.node.mode,
            count: devices.length,
            devices
          })
        }

        if (path === '/api/manage/pairing') {
          if (!this.node.accessControl) {
            return this._json(res, {
              enabled: false,
              mode: this.node.mode,
              pairing: null
            })
          }
          const state = this.node.accessControl._pairingState
          return this._json(res, {
            enabled: true,
            mode: this.node.mode,
            pairing: state
              ? {
                  active: this.node.accessControl.isPairing,
                  expiresAt: state.expiresAt
                }
              : { active: false, expiresAt: null }
          })
        }

        if (path === '/api/manage/modes') {
          return this._json(res, {
            current: this.node._operatingMode || 'standard',
            available: [
              {
                id: 'public',
                name: 'Public',
                description: 'Public relay defaults with open access'
              },
              {
                id: 'standard',
                name: 'Standard Relay',
                description: 'Full relay + seeding + all services'
              },
              {
                id: 'private',
                name: 'Private',
                description: 'LAN-friendly closed mode with allowlist and pairing'
              },
              {
                id: 'hybrid',
                name: 'Hybrid',
                description: 'Public discovery with private admission control'
              },
              {
                id: 'homehive',
                name: 'HomeHive',
                description: 'Home/personal relay — LAN priority, low resources, family-friendly'
              },
              {
                id: 'seed-only',
                name: 'Seed Only',
                description: 'App seeding only — no circuit relay'
              },
              {
                id: 'relay-only',
                name: 'Relay Only',
                description: 'Circuit relay only — no app seeding'
              },
              {
                id: 'stealth',
                name: 'Stealth',
                description: 'Tor-only, minimal footprint, no HTTP API on clearnet'
              },
              {
                id: 'gateway',
                name: 'Gateway',
                description: 'HTTP gateway focus — serve Hyperdrive content over HTTPS'
              }
            ]
          })
        }
      }

      // 404
      this._json(res, { error: 'Not found' }, 404)
    } catch (err) {
      if (err && err.message === 'Invalid JSON body') {
        return this._json(res, { error: 'Invalid JSON body' }, 400)
      }
      if (err && err.message === 'Request body too large') {
        return this._json(res, { error: 'Request body too large' }, 413)
      }
      this.emit('error', { context: 'api-handler', error: err })
      this._json(res, { error: 'Internal server error' }, 500)
    }
  }

  /**
   * Determine the Access-Control-Allow-Origin value for this request.
   * Returns the origin string to set, or null if the origin is not allowed.
   */
  _getAllowedOrigin (requestOrigin) {
    if (this.corsOrigins === '*') return '*'

    const allowed = Array.isArray(this.corsOrigins) ? this.corsOrigins : [this.corsOrigins]

    if (!requestOrigin) return null
    if (allowed.includes(requestOrigin)) return requestOrigin
    return null
  }

  _json (res, data, status = 200) {
    res.writeHead(status)
    res.end(JSON.stringify(data) + '\n')
  }

  _readBody (req) {
    return new Promise((resolve, reject) => {
      let data = ''
      let size = 0
      const MAX_BODY = 64 * 1024 // 64 KB max body

      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          req.destroy()
          reject(new Error('Request body too large'))
          return
        }
        data += chunk
      })
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {})
        } catch {
          reject(new Error('Invalid JSON body'))
        }
      })
      req.on('error', reject)
    })
  }

  // ─── Management Handlers ──────────────────────────────────────────

  _validatePositiveInt (value, min, max, name) {
    const parsed = parseInt(value, 10)
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return { ok: false, value: null, error: name + ' must be a valid integer' }
    }
    if (parsed < min || parsed > max) {
      return { ok: false, value: null, error: name + ' must be between ' + min + ' and ' + max }
    }
    return { ok: true, value: parsed, error: null }
  }

  _validatePositiveNumber (value, min, max, name) {
    const parsed = Number(value)
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return { ok: false, value: null, error: name + ' must be a valid number' }
    }
    if (parsed < min || parsed > max) {
      return { ok: false, value: null, error: name + ' must be between ' + min + ' and ' + max }
    }
    return { ok: true, value: parsed, error: null }
  }

  _handleConfigUpdate (res, body) {
    const applied = []
    const config = this.node.config

    // Bounds definitions for numeric config fields
    const intFields = {
      maxStorageBytes: { min: 1048576, max: 10e12 },
      maxConnections: { min: 1, max: 100000 },
      maxCircuitsPerPeer: { min: 1, max: 1000 },
      maxCircuitDuration: { min: 1000, max: 86400000 },
      maxCircuitBytes: { min: 1024, max: 10e12 },
      announceInterval: { min: 1000, max: 3600000 },
      replicationCheckInterval: { min: 10000, max: 3600000 },
      targetReplicaFloor: { min: 1, max: 16 },
      catalogSignatureMaxAgeMs: { min: 1000, max: 86400000 },
      catalogMaxAppAgeMs: { min: 0, max: 31536000000 },
      shutdownTimeoutMs: { min: 1000, max: 300000 }
    }

    for (const [field, bounds] of Object.entries(intFields)) {
      if (body[field] !== undefined) {
        const result = this._validatePositiveInt(body[field], bounds.min, bounds.max, field)
        if (!result.ok) {
          return this._json(res, { error: result.error }, 400)
        }
        config[field] = result.value
        applied.push(field)
      }
    }

    if (body.maxRelayBandwidthMbps !== undefined) {
      const result = this._validatePositiveNumber(body.maxRelayBandwidthMbps, 0.1, 100000, 'maxRelayBandwidthMbps')
      if (!result.ok) {
        return this._json(res, { error: result.error }, 400)
      }
      config.maxRelayBandwidthMbps = result.value
      applied.push('maxRelayBandwidthMbps')
    }

    if (body.registryAutoAccept !== undefined) {
      config.registryAutoAccept = body.registryAutoAccept !== false
      applied.push('registryAutoAccept')
    }
    if (body.replicationRepairEnabled !== undefined) {
      config.replicationRepairEnabled = body.replicationRepairEnabled !== false
      applied.push('replicationRepairEnabled')
    }
    if (body.gatewayPublicOnlyPrivacyTier !== undefined) {
      config.gatewayPublicOnlyPrivacyTier = body.gatewayPublicOnlyPrivacyTier !== false
      applied.push('gatewayPublicOnlyPrivacyTier')
    }
    if (body.strictSeedingPrivacy !== undefined) {
      config.strictSeedingPrivacy = body.strictSeedingPrivacy !== false
      applied.push('strictSeedingPrivacy')
    }
    if (body.requireSignedCatalog !== undefined) {
      config.requireSignedCatalog = body.requireSignedCatalog === true
      applied.push('requireSignedCatalog')
    }
    if (body.regions !== undefined) {
      config.regions = Array.isArray(body.regions) ? body.regions : []
      applied.push('regions')
    }
    if (body.discovery && typeof body.discovery === 'object') {
      config.discovery = {
        ...(config.discovery || {}),
        ...body.discovery
      }
      applied.push('discovery')
    }
    if (body.access && typeof body.access === 'object') {
      config.access = {
        ...(config.access || {}),
        ...body.access
      }
      applied.push('access')
    }
    if (body.pairing && typeof body.pairing === 'object') {
      config.pairing = {
        ...(config.pairing || {}),
        ...body.pairing
      }
      applied.push('pairing')
    }

    // Persist config changes to disk
    this._persistConfig().catch(() => {})

    return this._json(res, {
      ok: true,
      applied,
      config: this._getSafeConfig()
    })
  }

  _handleServiceManagement (res, body) {
    if (!this.node.serviceRegistry) {
      return this._json(res, { error: 'Services not enabled' }, 503)
    }

    const { action, service } = body
    if (!action || !service) {
      return this._json(res, {
        error: 'action and service required (action: enable|disable|restart)'
      }, 400)
    }

    const registry = this.node.serviceRegistry

    if (action === 'disable') {
      if (!registry.services.has(service)) {
        return this._json(res, { error: `Service '${service}' not found` }, 404)
      }
      registry.unregister(service).then(() => {
        this._json(res, { ok: true, action: 'disabled', service })
      }).catch(err => {
        this._json(res, { error: err.message }, 500)
      })
      return
    }

    if (action === 'restart') {
      const provider = registry.services.get(service)
      if (!provider) {
        return this._json(res, { error: `Service '${service}' not found` }, 404)
      }
      const ctx = { node: this.node, store: this.node.store, config: this.node.config }
      provider.stop().then(() => provider.start(ctx)).then(() => {
        this._json(res, { ok: true, action: 'restarted', service })
      }).catch(err => {
        this._json(res, { error: err.message }, 500)
      })
      return
    }

    return this._json(res, {
      error: 'Unknown action: ' + action + ' (use: disable, restart)'
    }, 400)
  }

  async _handleModeSwitch (res, body) {
    const { mode } = body
    if (!mode) {
      return this._json(res, { error: 'mode required' }, 400)
    }

    if (!AVAILABLE_MODES.includes(mode)) {
      return this._json(res, {
        error: 'Unknown mode: ' + mode,
        available: AVAILABLE_MODES
      }, 400)
    }

    try {
      const overrides = {}
      if (body.maxConnections !== undefined) overrides.maxConnections = body.maxConnections
      if (body.maxRelayBandwidthMbps !== undefined) overrides.maxRelayBandwidthMbps = body.maxRelayBandwidthMbps
      if (body.maxStorageBytes !== undefined) overrides.maxStorageBytes = body.maxStorageBytes
      if (body.discovery && typeof body.discovery === 'object') overrides.discovery = body.discovery
      if (body.access && typeof body.access === 'object') overrides.access = body.access
      if (body.pairing && typeof body.pairing === 'object') overrides.pairing = body.pairing
      if (body.registryAutoAccept !== undefined) overrides.registryAutoAccept = body.registryAutoAccept !== false

      await this.node.applyMode(mode, overrides)
    } catch (err) {
      return this._json(res, { error: err.message || 'Failed to apply mode' }, 400)
    }

    // Persist
    this._persistConfig().catch(() => {})

    return this._json(res, {
      ok: true,
      mode,
      applied: ['mode'],
      note: mode === 'stealth'
        ? 'Enable Tor transport for full stealth mode'
        : mode === 'homehive'
          ? 'HomeHive mode active — low resource, LAN-priority'
          : null
    })
  }

  async _handleDeviceManagement (res, body) {
    if (!this.node.accessControl) {
      return this._json(res, {
        error: 'Access control is not active in current mode',
        mode: this.node.mode
      }, 400)
    }

    const action = body.action || 'list'
    if (action === 'list') {
      const devices = this.node.listDevices()
      return this._json(res, { ok: true, count: devices.length, devices })
    }

    if (action === 'add') {
      if (!body.pubkey || !isValidHexKey(body.pubkey, 64)) {
        return this._json(res, { error: 'pubkey must be 64 hex characters' }, 400)
      }
      await this.node.addDevice(body.pubkey, body.name || 'manual')
      return this._json(res, { ok: true, action: 'added', pubkey: body.pubkey })
    }

    if (action === 'remove') {
      if (!body.pubkey || !isValidHexKey(body.pubkey, 64)) {
        return this._json(res, { error: 'pubkey must be 64 hex characters' }, 400)
      }
      await this.node.removeDevice(body.pubkey)
      return this._json(res, { ok: true, action: 'removed', pubkey: body.pubkey })
    }

    return this._json(res, { error: 'Unknown action (use list, add, remove)' }, 400)
  }

  _handlePairingManagement (res, body) {
    if (!this.node.accessControl) {
      return this._json(res, {
        error: 'Pairing is not available in current mode',
        mode: this.node.mode
      }, 400)
    }

    const action = body.action || 'status'
    if (action === 'status') {
      const state = this.node.accessControl._pairingState
      return this._json(res, {
        ok: true,
        active: this.node.accessControl.isPairing,
        expiresAt: state ? state.expiresAt : null
      })
    }

    if (action === 'start') {
      const timeoutMs = body.timeoutMs ? Number(body.timeoutMs) : undefined
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 30 * 60 * 1000)) {
        return this._json(res, { error: 'timeoutMs must be between 10000 and 1800000' }, 400)
      }
      const pairing = this.node.enablePairing({ timeoutMs })
      return this._json(res, {
        ok: true,
        active: true,
        ...pairing
      })
    }

    if (action === 'stop') {
      this.node.accessControl.disablePairing()
      return this._json(res, { ok: true, active: false })
    }

    return this._json(res, { error: 'Unknown action (use status, start, stop)' }, 400)
  }

  _handleTransportToggle (res, body) {
    const { transport, enabled } = body
    if (!transport) {
      return this._json(res, { error: 'transport required' }, 400)
    }

    if (!this.node.config.transports) {
      this.node.config.transports = { udp: true }
    }

    this.node.config.transports[transport] = enabled !== false

    this._persistConfig().catch(() => {})

    return this._json(res, {
      ok: true,
      transport,
      enabled: this.node.config.transports[transport],
      note: 'Transport changes may require a node restart to take full effect'
    })
  }

  _getSafeConfig () {
    const c = this.node.config
    return {
      storage: c.storage,
      maxStorageBytes: c.maxStorageBytes,
      maxConnections: c.maxConnections,
      maxRelayBandwidthMbps: c.maxRelayBandwidthMbps,
      enableRelay: c.enableRelay,
      enableSeeding: c.enableSeeding,
      enableMetrics: c.enableMetrics,
      enableAPI: c.enableAPI,
      apiPort: c.apiPort,
      apiHost: c.apiHost,
      corsOrigins: c.corsOrigins,
      regions: c.regions || [],
      discovery: c.discovery || { dht: true, announce: true, mdns: false },
      access: c.access || { open: true, allowlist: [] },
      pairing: c.pairing || { enabled: false },
      transports: c.transports || { udp: true },
      registryAutoAccept: c.registryAutoAccept,
      maxCircuitsPerPeer: c.maxCircuitsPerPeer,
      maxCircuitDuration: c.maxCircuitDuration,
      maxCircuitBytes: c.maxCircuitBytes,
      announceInterval: c.announceInterval,
      requireSignedCatalog: c.requireSignedCatalog,
      catalogSignatureMaxAgeMs: c.catalogSignatureMaxAgeMs,
      catalogMaxAppAgeMs: c.catalogMaxAppAgeMs,
      strictSeedingPrivacy: c.strictSeedingPrivacy,
      gatewayPublicOnlyPrivacyTier: c.gatewayPublicOnlyPrivacyTier,
      replicationCheckInterval: c.replicationCheckInterval,
      replicationRepairEnabled: c.replicationRepairEnabled,
      targetReplicaFloor: c.targetReplicaFloor,
      shutdownTimeoutMs: c.shutdownTimeoutMs,
      mode: this.node._operatingMode || 'standard'
    }
  }

  async _persistConfig () {
    try {
      const { saveConfig } = await import('../../config/loader.js')
      saveConfig(this._getSafeConfig())
    } catch (_) {
      // Config persistence is best-effort
    }
  }

  async stop () {
    if (this._dashboardFeed) {
      this._dashboardFeed.stop()
      this._dashboardFeed = null
    }

    if (this._gateway) {
      await this._gateway.close()
    }

    if (this._rateLimitCleanup) {
      clearInterval(this._rateLimitCleanup)
      this._rateLimitCleanup = null
    }
    this._rateLimits.clear()

    if (!this.server) return
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null
        this.emit('stopped')
        resolve()
      })
    })
  }
}
