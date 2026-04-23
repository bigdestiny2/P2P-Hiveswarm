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
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import { DashboardFeed } from './ws-feed.js'
import { HyperGateway } from '../../gateway/hyper-gateway.js'
import { CONTENT_TYPES, isValidHexKey, normalizeContentType, normalizePrivacyTier } from '../constants.js'
import { buildCapabilityDoc } from '../capability-doc.js'
import { verifySeedingManifest } from '../seeding-manifest.js'
import { ERR, formatErr } from '../error-prefixes.js'
import { SetupWizard } from '../wizard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Lazily-created CommonJS `require` for the rare synchronous file reads this
// module does (package version lookup). One instance per process.
let _cachedSyncRequire = null
function _getSyncRequire () {
  if (_cachedSyncRequire) return _cachedSyncRequire
  _cachedSyncRequire = createRequire(import.meta.url)
  return _cachedSyncRequire
}

const DEFAULT_PORT = 9100

// Rate limit: 60 requests per minute per IP
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

const MAX_DISCOVERY_KEYS = 100
const PRIVACY_TIER_ERROR = 'privacyTier must be one of: public, local-first, p2p-only'
const CONTENT_TYPE_ERROR = `type must be one of: ${Array.from(CONTENT_TYPES).join(', ')}`
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
    // Nullish-coalesce so `apiPort: 0` (OS-selected port, used in tests) is
    // honored instead of falling through to the default 9100.
    this.port = (opts.apiPort !== undefined && opts.apiPort !== null) ? opts.apiPort : DEFAULT_PORT
    this.host = opts.apiHost || '0.0.0.0'
    this.corsOrigins = opts.corsOrigins || []
    this.trustProxy = opts.trustProxy || false
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
    this._wizardHtml = null
    this._dashboardFeed = null
    this._wizard = null // lazily constructed by _getWizard() on first /api/wizard hit
    this._gateway = new HyperGateway(relayNode, { store: relayNode.store })
  }

  async start () {
    this.server = createServer((req, res) => this._handle(req, res))

    // Clean stale rate limit entries every 2 minutes. unref so it never
    // keeps the process alive on its own — callers rely on api.stop() for
    // deterministic teardown, but an unref'd interval means "forgot to
    // stop()" in a test doesn't hang the Node event loop.
    this._rateLimitCleanup = setInterval(() => {
      const now = Date.now()
      for (const [ip, entry] of this._rateLimits) {
        if (now > entry.resetAt) this._rateLimits.delete(ip)
      }
    }, 120_000)
    if (this._rateLimitCleanup.unref) this._rateLimitCleanup.unref()

    // Warn if binding to non-loopback without an API key — all requests
    // will pass the localhost auth check when behind a reverse proxy.
    if (!this._apiKey && this.host !== '127.0.0.1' && this.host !== '::1') {
      const msg = `[SECURITY WARNING] API binding to ${this.host}:${this.port} without an API key. ` +
        'Management endpoints are protected only by localhost check, which is ineffective behind a reverse proxy. ' +
        'Set an API key via HIVERELAY_API_KEY or opts.apiKey.'
      if (this.node && typeof this.node.emit === 'function') {
        this.node.emit('security-warning', { message: msg })
      }
      console.warn(msg)
    }

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

  /**
   * Extract the real client IP from the request.
   * When trustProxy is enabled, reads X-Forwarded-For or X-Real-IP headers.
   * Otherwise falls back to socket remoteAddress.
   */
  _getClientIP (req) {
    if (this.trustProxy) {
      const xff = req.headers['x-forwarded-for']
      if (xff) {
        // X-Forwarded-For may contain multiple IPs; the leftmost is the client
        const first = xff.split(',')[0].trim()
        if (first) return first
      }
      const realIP = req.headers['x-real-ip']
      if (realIP) return realIP.trim()
    }
    return req.socket.remoteAddress || ''
  }

  _isLocalRequest (req) {
    const ip = this._getClientIP(req)
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
  }

  _requireAuth (req, res, errorMessage) {
    if (this._checkAuth(req)) return true
    // `error` is the legacy human-readable string — kept for back-compat so
    // existing clients string-matching on it don't break. `errorCode` is the
    // machine-readable prefix form new clients should branch
    // on: err.body.errorCode === 'auth-required' → retry after sign-in.
    this._json(res, {
      error: errorMessage,
      errorCode: ERR.AUTH_REQUIRED.trim().replace(/:$/, '')
    }, 401)
    return false
  }

  _readPrivacyTier (value, fallback = 'public') {
    return normalizePrivacyTier(value, fallback)
  }

  _readContentType (value, fallback = 'app') {
    return normalizeContentType(value, fallback)
  }

  async _handle (req, res) {
    const ip = this._getClientIP(req) || '127.0.0.1'
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

      // Catalog endpoint — typed content catalog (apps, drives, resources, datasets, media)
      if (req.method === 'GET' && path === '/catalog.json') {
        const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1)
        const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('pageSize')) || 50, 1), 500)
        const requestedType = url.searchParams.get('type')
        const parent = url.searchParams.get('parent')
        const category = url.searchParams.get('category')
        const normalizedType = requestedType ? this._readContentType(requestedType, null) : null
        if (requestedType && !normalizedType) {
          return this._json(res, { error: CONTENT_TYPE_ERROR }, 400)
        }

        const allEntries = this.node.appRegistry.catalog()
        const filtered = allEntries.filter((entry) => {
          if (normalizedType && entry.type !== normalizedType) return false
          if (parent && entry.parentKey !== parent) return false
          if (category) {
            const categories = Array.isArray(entry.categories) ? entry.categories : []
            if (!categories.some(c => String(c).toLowerCase() === String(category).toLowerCase())) return false
          }
          return true
        })

        const total = filtered.length
        const start = (page - 1) * pageSize
        const paged = filtered.slice(start, start + pageSize)
        const apps = paged.filter(entry => entry.type === 'app')
        const drives = paged.filter(entry => entry.type === 'drive' && !entry.parentKey)
        const resources = paged.filter(entry => entry.type === 'drive' && entry.parentKey)
        const datasets = paged.filter(entry => entry.type === 'dataset')
        const media = paged.filter(entry => entry.type === 'media')

        res.setHeader('Content-Type', 'application/json')
        return this._json(res, {
          version: 2,
          name: 'HiveRelay Content Catalog',
          relayKey: this.node.swarm
            ? Buffer.from(this.node.swarm.keyPair.publicKey).toString('hex')
            : null,
          filters: {
            type: normalizedType,
            parent: parent || null,
            category: category || null
          },
          pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            hasNext: start + pageSize < total,
            hasPrev: page > 1
          },
          count: {
            total,
            apps: filtered.filter(entry => entry.type === 'app').length,
            drives: filtered.filter(entry => entry.type === 'drive' && !entry.parentKey).length,
            resources: filtered.filter(entry => entry.type === 'drive' && entry.parentKey).length,
            datasets: filtered.filter(entry => entry.type === 'dataset').length,
            media: filtered.filter(entry => entry.type === 'media').length
          },
          // apps remains for backward compatibility with existing catalog clients.
          apps,
          drives,
          resources,
          datasets,
          media,
          entries: paged,
          // Per-relay local catalog model: declare which other relays this
          // operator has chosen to follow / mirror so clients can reason about
          // where content came from and which other catalogs to also query.
          federation: this.node.federation ? this.node.federation.snapshot() : null,
          acceptMode: this.node._resolveAcceptMode ? this.node._resolveAcceptMode() : null
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
          return this._serveDashboard(res, '_dashboardHtml', 'index.html')
        }

        // First-run setup wizard UI. Localhost-only because the form
        // collects secrets (LNbits admin key); the JSON endpoints
        // /api/wizard/* enforce the same restriction.
        if (path === '/wizard') {
          if (!this._isLocalRequest(req)) {
            res.setHeader('Content-Type', 'text/plain')
            res.writeHead(403)
            res.end('Wizard is localhost-only.\n')
            return
          }
          return this._serveDashboard(res, '_wizardHtml', 'wizard.html')
        }

        // Smart root route: send freshly-installed users to the wizard,
        // returning operators to the dashboard. Uses HTTP 302 so browser
        // refreshes don't get cached.
        if (path === '/') {
          const wizard = await this._getWizard()
          const target = wizard.isComplete() ? '/dashboard' : '/wizard'
          res.setHeader('Location', target)
          res.writeHead(302)
          res.end()
          return
        }

        if (path === '/network') {
          return this._serveDashboard(res, '_networkHtml', 'network.html')
        }

        if (path === '/docs') {
          return this._serveDashboard(res, '_docsHtml', 'docs.html')
        }

        if (path === '/payments') {
          return this._serveDashboard(res, '_paymentsHtml', 'payments.html')
        }

        if (path === '/calculator') {
          return this._serveDashboard(res, '_calculatorHtml', 'calculator.html')
        }

        if (path === '/leaderboard') {
          return this._serveDashboard(res, '_leaderboardHtml', 'leaderboard.html')
        }

        if (path === '/catalog') {
          return this._serveDashboard(res, '_catalogHtml', 'catalog.html')
        }

        if (path === '/api/health-detail') {
          const healthStatus = this.node.getHealthStatus()
          const actions = this.node.selfHeal ? this.node.selfHeal.getActions() : []
          return this._json(res, { ...healthStatus, actions })
        }

        // Capability advertisement — served at /.well-known/hiverelay.json so
        // clients can machine-detect what this relay offers (version, accept
        // policy, fees, features) without speaking Hypercore first. Also
        // mirrored at /api/capabilities for convenience. Both responses are
        // identical and cheap (<1ms to build).
        if (path === '/.well-known/hiverelay.json' || path === '/api/capabilities') {
          const doc = buildCapabilityDoc({
            relay: this.node,
            version: this._relayVersion(),
            runtime: 'node'
          })
          res.setHeader('Cache-Control', 'public, max-age=60')
          return this._json(res, doc)
        }

        // Author seeding manifest fetch. Clients GET this to discover which
        // relays an author uses for seeding. Returns 404 if we haven't cached
        // a manifest for this author — that's a normal state, not an error.
        const authorMatch = path.match(/^\/api\/authors\/([0-9a-f]{64})\/seeding\.json$/i)
        if (authorMatch) {
          if (!this.node.manifestStore) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'manifest store not initialized') }, 503)
          }
          const manifest = this.node.manifestStore.get(authorMatch[1])
          if (!manifest) {
            return this._json(res, { error: formatErr('NOT_FOUND', 'no seeding manifest for this author') }, 404)
          }
          res.setHeader('Cache-Control', 'public, max-age=30')
          return this._json(res, manifest)
        }

        // Fork-proof gossip — public list of fork records this relay
        // has observed or had pushed to it by federation peers. Clients
        // and peer relays poll this to learn about equivocation across
        // the network. No auth required; fork proofs are public goods
        // (the offending publisher's signatures are visible by design).
        // Capped at 200 entries per response.
        if (path === '/api/forks/proofs') {
          if (!this.node.forkDetector) {
            return this._json(res, { schemaVersion: 1, proofs: [] })
          }
          const proofs = this.node.forkDetector.list().slice(0, 200)
          res.setHeader('Cache-Control', 'public, max-age=30')
          return this._json(res, { schemaVersion: 1, proofs })
        }

        // First-run setup wizard — serves the current state machine. The
        // dashboard checks `isComplete` on load and either renders the
        // wizard or the main UI. Localhost-only by design (the wizard
        // accepts secrets like LNbits admin keys).
        if (path === '/api/wizard') {
          if (!this._isLocalRequest(req)) {
            return this._json(res, { error: formatErr('NOT_ALLOWED', 'wizard is localhost-only') }, 403)
          }
          const wizard = await this._getWizard()
          return this._json(res, wizard.snapshot())
        }

        if (path === '/api/alerts') {
          if (!this.node.alertManager) {
            return this._json(res, { enabled: false, total: 0, offset: 0, limit: 0, items: [] })
          }
          const offset = parseInt(url.searchParams.get('offset')) || 0
          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit')) || 50, 1), 500)
          const severity = url.searchParams.get('severity') || undefined
          const typeFilter = url.searchParams.get('type') || undefined
          const logOut = this.node.alertManager.getLog({ offset, limit, severity, type: typeFilter })
          return this._json(res, { enabled: true, ...logOut })
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
              type: this._readContentType(entry.type, 'app'),
              parentKey: entry.parentKey || null,
              mountPath: entry.mountPath || null,
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

        if (path === '/api/drives') {
          const drives = []
          const now = Date.now()
          for (const [appKey, entry] of this.node.seededApps) {
            if (this._readContentType(entry.type, 'app') !== 'drive') continue
            drives.push({
              appKey,
              type: 'drive',
              parentKey: entry.parentKey || null,
              mountPath: entry.mountPath || null,
              appId: entry.appId || null,
              name: entry.name || entry.appId || null,
              description: entry.description || '',
              author: entry.author || null,
              categories: entry.categories || [],
              privacyTier: entry.privacyTier || 'public',
              version: entry.version || null,
              discoveryKey: entry.discoveryKey ? (typeof entry.discoveryKey === 'string' ? entry.discoveryKey : Buffer.from(entry.discoveryKey).toString('hex')) : null,
              startedAt: entry.startedAt,
              bytesServed: entry.bytesServed || 0,
              uptimeMinutes: Math.round((now - entry.startedAt) / 60_000)
            })
          }
          return this._json(res, drives)
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

        if (path === '/api/registry/pending' || path === '/api/manage/catalog/pending') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for ' + path)) return
          const pending = []
          for (const [appKey, entry] of this.node._pendingRequests) {
            pending.push({ appKey, ...entry })
          }
          return this._json(res, {
            count: pending.length,
            mode: this.node._resolveAcceptMode ? this.node._resolveAcceptMode() : null,
            requests: pending
          })
        }

        if (path === '/api/manage/federation') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation')) return
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          return this._json(res, this.node.federation.snapshot())
        }

        if (path === '/api/manage/delegation/revocations') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/delegation/revocations')) return
          const list = this.node.listRevocations ? this.node.listRevocations() : []
          return this._json(res, { count: list.length, revocations: list })
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
          if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
            return this._json(res, { error: 'Invalid pubkey' }, 400)
          }
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

        // Seeding manifest publish. Any signed, verified manifest is
        // accepted — no API key required, because the signature on the
        // manifest IS the authorization. Unsigned or tampered manifests
        // are rejected at the signature-verification step below.
        if (path === '/api/authors/seeding.json') {
          if (!this.node.manifestStore) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'manifest store not initialized') }, 503)
          }
          if (!body || typeof body !== 'object') {
            return this._json(res, { error: formatErr('BAD_REQUEST', 'manifest required') }, 400)
          }
          // Double-check signature before even touching the store (defence in
          // depth — the store also verifies, but failing fast here avoids
          // log noise for obvious garbage).
          const check = verifySeedingManifest(body)
          if (!check.valid) {
            return this._json(res, { error: formatErr('BAD_REQUEST', 'invalid manifest: ' + check.reason) }, 400)
          }
          const result = this.node.manifestStore.put(body)
          if (!result.ok) {
            // 'stale' is a normal outcome (client has an older copy); 409 Conflict.
            const status = /stale/.test(result.reason) ? 409 : 400
            return this._json(res, { error: formatErr('BAD_REQUEST', result.reason) }, status)
          }
          try { await this.node.manifestStore.save() } catch (err) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'manifest persist failed: ' + err.message) }, 500)
          }
          return this._json(res, { ok: true, pubkey: check.pubkey, replaced: result.replaced })
        }

        // Fork-proof gossip — receive a fork proof from a federation
        // peer or a client that observed equivocation. No auth required;
        // bad-shape proofs are silently rejected at the ForkDetector
        // layer. We rate-limit at the per-IP level (the rate limiter
        // higher up applies to all endpoints).
        if (path === '/api/forks/proof') {
          if (!this.node.forkDetector) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'fork detector not initialized') }, 503)
          }
          if (!body || typeof body !== 'object') {
            return this._json(res, { error: formatErr('BAD_REQUEST', 'fork proof body required') }, 400)
          }
          const result = this.node.forkDetector.report({
            hypercoreKey: body.hypercoreKey,
            blockIndex: typeof body.blockIndex === 'number' ? body.blockIndex : 0,
            evidenceA: body.evidenceA,
            evidenceB: body.evidenceB
          })
          if (!result.ok) {
            return this._json(res, { error: formatErr('BAD_REQUEST', result.reason) }, 400)
          }
          try { await this.node.forkDetector.save() } catch (err) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'fork persist failed: ' + err.message) }, 500)
          }
          return this._json(res, { ok: true, recordExists: result.recordExists })
        }

        // ─── Setup wizard mutations ──────────────────────────────
        // Five POST endpoints, one per wizard step. All localhost-only —
        // they accept secrets (LNbits admin key) and configuration
        // changes. The dashboard front-end calls these in sequence as
        // the operator clicks through the 5-step flow.
        if (path.startsWith('/api/wizard/')) {
          if (!this._isLocalRequest(req)) {
            return this._json(res, { error: formatErr('NOT_ALLOWED', 'wizard is localhost-only') }, 403)
          }
          const wizard = await this._getWizard()
          const action = path.slice('/api/wizard/'.length)
          let result
          switch (action) {
            case 'goto':
              result = wizard.goToStep({ step: body && body.step })
              break
            case 'relay-name':
              result = wizard.setRelayName({ relayName: body && body.relayName })
              break
            case 'lnbits':
              // setLNbitsCredentials is async — it encrypts the admin key
              // before storing. Failures here are reported as bad-request
              // since the most likely cause is a bad input (missing key)
              // rather than internal failure.
              result = await wizard.setLNbitsCredentials({ url: body && body.url, adminKey: body && body.adminKey })
              break
            case 'accept-mode':
              result = wizard.setAcceptMode({ acceptMode: body && body.acceptMode })
              break
            case 'complete':
              result = wizard.complete()
              // Apply wizard answers to the live config. toConfig() is
              // async because it decrypts the LNbits admin key.
              if (result.ok && this.node._applyWizardConfig) {
                try {
                  const cfg = await wizard.toConfig()
                  this.node._applyWizardConfig(cfg)
                } catch (err) {
                  return this._json(res, { error: formatErr('UNSUPPORTED', 'failed to apply wizard config: ' + err.message) }, 500)
                }
              }
              break
            case 'reset':
              wizard.reset()
              result = { ok: true, state: wizard.snapshot() }
              break
            default:
              return this._json(res, { error: formatErr('NOT_FOUND', 'unknown wizard action: ' + action) }, 404)
          }
          if (!result.ok) {
            return this._json(res, { error: formatErr('BAD_REQUEST', result.reason) }, 400)
          }
          try { await wizard.save() } catch (err) {
            return this._json(res, { error: formatErr('UNSUPPORTED', 'wizard persist failed: ' + err.message) }, 500)
          }
          return this._json(res, { ok: true, state: result.state })
        }

        if (path === '/api/alerts/test') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/alerts/test')) return
          if (!this.node.alertManager) {
            return this._json(res, { error: 'AlertManager not enabled' }, 503)
          }
          const dispatched = this.node.alertManager.fireTest({
            severity: body && typeof body.severity === 'string' ? body.severity : undefined,
            message: body && typeof body.message === 'string' ? body.message : undefined,
            details: body && typeof body.details === 'object' ? body.details : undefined
          })
          return this._json(res, { ok: true, dispatched })
        }

        if (path === '/seed') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /seed')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          const seedOpts = body.opts || {}
          const requestedType = body.type !== undefined ? body.type : seedOpts.type
          if (requestedType !== undefined) {
            const type = this._readContentType(requestedType, null)
            if (!type) return this._json(res, { error: CONTENT_TYPE_ERROR }, 400)
            seedOpts.type = type
          }
          // Forward appId from request body for deduplication
          if (body.appId && typeof body.appId === 'string') seedOpts.appId = body.appId
          if (body.version && typeof body.version === 'string') seedOpts.version = body.version
          if (body.parentKey !== undefined) {
            if (typeof body.parentKey !== 'string' || !isValidHexKey(body.parentKey, 64)) {
              return this._json(res, { error: 'parentKey must be a 64-character hex key' }, 400)
            }
            seedOpts.parentKey = body.parentKey
          }
          if (body.mountPath !== undefined) {
            if (typeof body.mountPath !== 'string') return this._json(res, { error: 'mountPath must be a string' }, 400)
            const mountPath = body.mountPath.trim()
            if (!mountPath.startsWith('/')) return this._json(res, { error: 'mountPath must start with "/"' }, 400)
            if (mountPath.length > 256) return this._json(res, { error: 'mountPath exceeds max length (256)' }, 400)
            seedOpts.mountPath = mountPath
          }
          if ((seedOpts.parentKey || seedOpts.mountPath) && !seedOpts.type) {
            seedOpts.type = 'drive'
          }
          if ((seedOpts.parentKey || seedOpts.mountPath) && seedOpts.type && seedOpts.type !== 'drive') {
            return this._json(res, { error: 'parentKey and mountPath are only supported when type is "drive"' }, 400)
          }
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
          const rawContentType = body.contentType !== undefined ? body.contentType : body.type
          const contentType = this._readContentType(rawContentType, 'app')
          if (rawContentType !== undefined && this._readContentType(rawContentType, null) === null) {
            return this._json(res, { error: CONTENT_TYPE_ERROR }, 400)
          }
          let parentKey = null
          if (body.parentKey !== undefined) {
            if (typeof body.parentKey !== 'string' || !isValidHexKey(body.parentKey, 64)) {
              return this._json(res, { error: 'parentKey must be a 64-character hex key' }, 400)
            }
            parentKey = body.parentKey
          }
          let mountPath = null
          if (body.mountPath !== undefined) {
            if (typeof body.mountPath !== 'string') return this._json(res, { error: 'mountPath must be a string' }, 400)
            mountPath = body.mountPath.trim()
            if (!mountPath.startsWith('/')) return this._json(res, { error: 'mountPath must start with "/"' }, 400)
            if (mountPath.length > 256) return this._json(res, { error: 'mountPath exceeds max length (256)' }, 400)
          }
          if ((parentKey || mountPath) && contentType !== 'drive') {
            return this._json(res, { error: 'parentKey and mountPath are only supported when type is "drive"' }, 400)
          }

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
            contentType,
            parentKey,
            mountPath,
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

        // ─── /api/manage/catalog/* — operator catalog controls ───────────
        // Replaces the older /registry/{auto-accept,approve,reject} endpoints
        // with a clearer surface aligned to the per-relay local-catalog model.

        if (path === '/api/manage/catalog/mode') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/catalog/mode')) return
          const m = body.mode
          if (!['open', 'review', 'allowlist', 'closed'].includes(m)) {
            return this._json(res, { error: 'mode must be one of: open, review, allowlist, closed' }, 400)
          }
          this.node.config.acceptMode = m
          delete this.node.config.registryAutoAccept // disambiguate
          return this._json(res, { ok: true, mode: m })
        }

        if (path === '/api/manage/catalog/allowlist') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/catalog/allowlist')) return
          if (!Array.isArray(body.allowlist)) {
            return this._json(res, { error: 'allowlist must be an array of publisher pubkeys (hex)' }, 400)
          }
          // Validate each entry is a hex pubkey before accepting.
          for (const k of body.allowlist) {
            if (typeof k !== 'string' || !isValidHexKey(k, 64)) {
              return this._json(res, { error: 'allowlist entries must be 64-char hex pubkeys' }, 400)
            }
          }
          this.node.config.acceptAllowlist = body.allowlist.slice()
          return this._json(res, { ok: true, allowlist: this.node.config.acceptAllowlist })
        }

        if (path === '/api/manage/catalog/approve') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/catalog/approve')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          await this.node.approveRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/api/manage/catalog/reject') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/catalog/reject')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          this.node.rejectRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/api/manage/catalog/remove') {
          // Operator-initiated removal of an app from the local catalog (and unseed).
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/catalog/remove')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          await this.node.unseedApp(body.appKey)
          return this._json(res, { ok: true })
        }

        // ─── /api/manage/federation/* — explicit cross-relay federation ──

        if (path === '/api/manage/federation/follow') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation/follow')) return
          if (!body.url || typeof body.url !== 'string') return this._json(res, { error: 'url required' }, 400)
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          this.node.federation.follow(body.url, { pubkey: body.pubkey || null })
          return this._json(res, { ok: true, mode: 'follow', url: body.url })
        }

        if (path === '/api/manage/federation/mirror') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation/mirror')) return
          if (!body.url || typeof body.url !== 'string') return this._json(res, { error: 'url required' }, 400)
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          this.node.federation.mirror(body.url, { pubkey: body.pubkey || null })
          return this._json(res, { ok: true, mode: 'mirror', url: body.url })
        }

        if (path === '/api/manage/federation/unfollow') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation/unfollow')) return
          if (!body.url || typeof body.url !== 'string') return this._json(res, { error: 'url required' }, 400)
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          const removed = this.node.federation.unfollow(body.url)
          return this._json(res, { ok: true, removed, url: body.url })
        }

        if (path === '/api/manage/federation/republish') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation/republish')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          this.node.federation.republish(body.appKey, {
            sourceUrl: body.sourceUrl || null,
            sourcePubkey: body.sourcePubkey || null,
            channel: body.channel || null,
            note: body.note || null
          })
          return this._json(res, { ok: true, appKey: body.appKey })
        }

        if (path === '/api/manage/federation/unrepublish') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/federation/unrepublish')) return
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          if (!this.node.federation) return this._json(res, { error: 'Federation not initialized' }, 503)
          const removed = this.node.federation.unrepublish(body.appKey)
          return this._json(res, { ok: true, removed, appKey: body.appKey })
        }

        // ─── /api/manage/delegation/* — device-attestation revocation ────

        if (path === '/api/manage/delegation/revoke') {
          if (!this._requireAuth(req, res, 'Unauthorized — API key required for /api/manage/delegation/revoke')) return
          const rev = body.revocation
          if (!rev || typeof rev !== 'object') {
            return this._json(res, { error: 'revocation required (signed message from primary identity)' }, 400)
          }
          const result = this.node.submitRevocation(rev, { certExpiresAt: body.certExpiresAt })
          if (!result.ok) return this._json(res, { error: result.reason }, 400)
          return this._json(res, result)
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
              this.node.emit('shutdown-complete', { clean: true })
            } catch (err) {
              this.node.emit('shutdown-complete', { clean: false, error: err })
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

  async _serveDashboard (res, cacheKey, filename) {
    if (!this[cacheKey]) {
      const htmlPath = join(__dirname, '..', '..', 'dashboard', filename)
      this[cacheKey] = await readFile(htmlPath, 'utf-8')
    }
    res.setHeader('Content-Type', 'text/html')
    res.writeHead(200)
    res.end(this[cacheKey])
  }

  _json (res, data, status = 200) {
    res.writeHead(status)
    res.end(JSON.stringify(data) + '\n')
  }

  /**
   * Lazily construct + load the SetupWizard. We don't create it eagerly
   * because relays running in non-interactive mode (CLI flags only,
   * env-var configs) never need it — wizard.json never gets written
   * unless the operator actually visits /api/wizard.
   *
   * Cached on first use; survives subsequent requests in the same
   * process. Goes away on container restart, then re-loaded from disk.
   */
  async _getWizard () {
    if (this._wizard) return this._wizard
    const storageDir = this.node.config && this.node.config.storage
      ? this.node.config.storage
      : '/data'
    this._wizard = new SetupWizard({
      storagePath: join(storageDir, 'wizard.json')
    })
    try { await this._wizard.load() } catch (err) {
      this.emit('wizard-error', { message: 'wizard load failed', error: err })
    }
    return this._wizard
  }

  // Lazy-read the package version from the core workspace's package.json.
  // Cached on first call; if reading fails we just return null rather than
  // crash the endpoint. Path calculation is relative to this file:
  //   packages/core/core/relay-node/api.js  →  packages/core/package.json
  _relayVersion () {
    if (this._cachedVersion !== undefined) return this._cachedVersion
    try {
      const pkgPath = join(__dirname, '..', '..', 'package.json')
      // Synchronous read via a freshly-created CommonJS `require` — avoids
      // turning this helper async (it's called from inside sync HTTP
      // handlers) and sidesteps the ESM top-level-await restriction. One
      // read per process, result cached.
      const req = _getSyncRequire()
      const { readFileSync } = req('fs')
      const raw = readFileSync(pkgPath, 'utf8')
      const pkg = JSON.parse(raw)
      this._cachedVersion = pkg.version || null
    } catch (_) {
      this._cachedVersion = null
    }
    return this._cachedVersion
  }

  _readBody (req, maxBytes = 65536) {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, val) => { if (!settled) { settled = true; fn(val) } }
      let data = ''
      let size = 0

      req.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          req.destroy()
          done(reject, new Error('Request body too large'))
          return
        }
        data += chunk
      })
      req.on('end', () => {
        try {
          done(resolve, data ? JSON.parse(data) : {})
        } catch {
          done(reject, new Error('Invalid JSON body'))
        }
      })
      req.on('error', (err) => done(reject, err))
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
    if (body.enableDistributedDriveBridge !== undefined) {
      config.enableDistributedDriveBridge = body.enableDistributedDriveBridge !== false
      applied.push('enableDistributedDriveBridge')
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

  async _handleServiceManagement (res, body) {
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
      try {
        await registry.unregister(service)
        this._json(res, { ok: true, action: 'disabled', service })
      } catch (err) {
        this._json(res, { error: err.message }, 500)
      }
      return
    }

    if (action === 'restart') {
      const provider = registry.services.get(service)
      if (!provider) {
        return this._json(res, { error: `Service '${service}' not found` }, 404)
      }
      const ctx = { node: this.node, store: this.node.store, config: this.node.config }
      try {
        await provider.stop()
        await provider.start(ctx)
        this._json(res, { ok: true, action: 'restarted', service })
      } catch (err) {
        this._json(res, { error: err.message }, 500)
      }
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
      if (body.maxConnections !== undefined) {
        const val = Number(body.maxConnections)
        if (!Number.isFinite(val) || val < 0) {
          return this._json(res, { error: 'maxConnections must be a non-negative number' }, 400)
        }
        overrides.maxConnections = val
      }
      if (body.maxRelayBandwidthMbps !== undefined) {
        const val = Number(body.maxRelayBandwidthMbps)
        if (!Number.isFinite(val) || val < 0) {
          return this._json(res, { error: 'maxRelayBandwidthMbps must be a non-negative number' }, 400)
        }
        overrides.maxRelayBandwidthMbps = val
      }
      if (body.maxStorageBytes !== undefined) {
        const val = Number(body.maxStorageBytes)
        if (!Number.isFinite(val) || val < 0) {
          return this._json(res, { error: 'maxStorageBytes must be a non-negative number' }, 400)
        }
        overrides.maxStorageBytes = val
      }
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
    if (!transport || typeof transport !== 'string') {
      return this._json(res, { error: 'transport required' }, 400)
    }

    if (transport === '__proto__' || transport === 'constructor' || transport === 'prototype') {
      return this._json(res, { error: 'Invalid transport name' }, 400)
    }

    if (!/^[a-z0-9-]+$/.test(transport)) {
      return this._json(res, { error: 'Invalid transport name' }, 400)
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
      enableDistributedDriveBridge: c.enableDistributedDriveBridge,
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
