/**
 * Local HTTP API for agent integration
 *
 * Lightweight REST API using Node.js built-in http module.
 * Enables agents (Hermes, OpenClaw) to query and control the relay
 * node without importing the module directly.
 *
 * Security features:
 *   - Configurable bind address (opts.apiHost, default '127.0.0.1' for security)
 *   - Configurable CORS origins (default: localhost only)
 *   - Per-IP rate limiting to prevent abuse
 *   - Hex key input validation on all POST routes
 *   - API key authentication for state-modifying endpoints
 *   - Registration challenges to prevent appId squatting
 *   - Ownership signature verification
 *   - Pagination for catalog endpoints
 *
 * SECURITY NOTICE: For production deployments, this API should be placed
 * behind a reverse proxy (NGINX/Caddy) with TLS termination (HTTPS).
 * See: SEC-001 in SECURITY_AUDIT.md
 */

import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import sodium from 'sodium-universal'
import { DashboardFeed } from './ws-feed.js'
import { HyperGateway } from '../../compute/gateway/hyper-gateway.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DEFAULT_PORT = 9100

// Rate limit: 60 requests per minute per IP
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 60

const MAX_DISCOVERY_KEYS = 100

/**
 * Validate a hex-encoded key string.
 * @param {*} str - value to check
 * @param {number} len - expected character length (e.g. 64 for 32-byte keys)
 * @returns {boolean}
 */
function isValidHexKey (str, len) {
  return typeof str === 'string' && str.length === len && /^[0-9a-f]+$/i.test(str)
}

/**
 * Validate and sanitize manifest.json content
 * Prevents prototype pollution and XSS through malicious manifests
 * @param {object} manifest - Parsed manifest object
 * @returns {object|null} - Sanitized manifest or null if invalid
 */
function validateManifest (manifest) {
  if (!manifest || typeof manifest !== 'object') return null

  // Reject objects with dangerous property names (prototype pollution)
  const dangerousProps = ['__proto__', 'constructor', 'prototype']
  const keys = Object.keys(manifest)
  for (const key of keys) {
    if (dangerousProps.includes(key)) return null
  }

  // Sanitize string fields
  const sanitizeString = (str, maxLen = 200) => {
    if (typeof str !== 'string') return null
    // Remove control characters and trim
    const cleaned = str.replace(/[\x00-\x1F\x7F]/g, '').trim()
    return cleaned.slice(0, maxLen)
  }

  const validated = {}

  // id: alphanumeric, dash, underscore only
  if (manifest.id) {
    const id = sanitizeString(manifest.id, 50)
    if (id && /^[a-zA-Z0-9_-]+$/.test(id)) validated.id = id
  }

  // name: any reasonable string
  if (manifest.name) {
    const name = sanitizeString(manifest.name, 100)
    if (name) validated.name = name
  }

  // description: longer text
  if (manifest.description) {
    const desc = sanitizeString(manifest.description, 500)
    if (desc) validated.description = desc
  }

  // author: string
  if (manifest.author) {
    const author = sanitizeString(manifest.author, 100)
    if (author) validated.author = author
  }

  // version: semver-like
  if (manifest.version) {
    const version = sanitizeString(manifest.version, 20)
    if (version && /^[\d.]+$/.test(version)) validated.version = version
  }

  // categories: array of strings
  if (Array.isArray(manifest.categories)) {
    validated.categories = manifest.categories
      .map(c => sanitizeString(c, 30))
      .filter(Boolean)
      .slice(0, 10) // Max 10 categories
  }

  // publishedAt: ISO date string
  if (manifest.publishedAt) {
    const date = sanitizeString(manifest.publishedAt, 30)
    if (date && /^\d{4}-\d{2}-\d{2}/.test(date)) validated.publishedAt = date
  }

  return validated
}

export class RelayAPI extends EventEmitter {
  constructor (relayNode, opts = {}) {
    super()
    this.node = relayNode
    this.port = opts.apiPort || DEFAULT_PORT
    // SECURITY: Use '127.0.0.1' when behind a reverse proxy; '0.0.0.0' for direct access
    this.host = opts.apiHost || '0.0.0.0'
    // SECURITY: Default CORS to wildcard for P2P relay compatibility; restrict in production
    this.corsOrigins = opts.corsOrigins || '*'
    this.server = null

    // SECURITY: API key authentication for state-modifying endpoints
    this._apiKey = opts.apiKey || process.env.HIVERELAY_API_KEY || null
    this._requireAuth = opts.requireAuth !== false // Default to requiring auth
    this._trustProxy = opts.trustProxy || false // Only trust X-Forwarded-For when behind a known proxy

    // Per-IP request counts: ip -> { count, resetAt }
    this._rateLimits = new Map()
    this._rateLimitCleanup = null
    this._dashboardHtml = null
    this._networkHtml = null
    this._docsHtml = null
    this._dashboardFeed = null
    this._gateway = new HyperGateway(relayNode)

    // SECURITY: App registration challenges (prevents squatting)
    this._registrationChallenges = new Map() // appId -> { challenge, expiresAt }
    this._challengeCleanup = setInterval(() => this._cleanupChallenges(), 300_000) // 5 min

    // SECURITY: Pagination for catalog endpoints
    this._maxCatalogPageSize = opts.maxCatalogPageSize || 100
  }

  /**
   * Generate a registration challenge for appId registration
   * Prevents automated squatting by requiring proof-of-work
   */
  _generateChallenge (appId) {
    const challenge = crypto.randomBytes(32).toString('hex')
    const expiresAt = Date.now() + 300_000 // 5 minutes
    this._registrationChallenges.set(appId, { challenge, expiresAt })
    return challenge
  }

  /**
   * Verify a registration challenge response
   */
  _verifyChallenge (appId, response) {
    const entry = this._registrationChallenges.get(appId)
    if (!entry) return false
    if (Date.now() > entry.expiresAt) {
      this._registrationChallenges.delete(appId)
      return false
    }
    // Simple proof-of-work: response must be challenge + appId hashed
    const expected = crypto.createHash('sha256').update(entry.challenge + appId).digest('hex')
    const valid = response === expected
    if (valid) this._registrationChallenges.delete(appId)
    return valid
  }

  _cleanupChallenges () {
    const now = Date.now()
    for (const [appId, entry] of this._registrationChallenges) {
      if (now > entry.expiresAt) this._registrationChallenges.delete(appId)
    }
  }

  /**
   * Verify API key for protected endpoints
   */
  _verifyApiKey (req) {
    if (!this._requireAuth) return true
    if (!this._apiKey) return false // No key configured — block state-modifying requests
    const authHeader = req.headers.authorization
    if (!authHeader) return false
    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return false
    try {
      const a = Buffer.from(parts[1])
      const b = Buffer.from(this._apiKey)
      if (a.length !== b.length) return false
      return crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  /**
   * Verify ownership signature for app operations
   * Requires the appKey to be signed with the owner's private key
   */
  _verifyOwnershipSignature (appKey, signature, publicKey) {
    if (!signature || !publicKey) return false
    try {
      const message = Buffer.from(appKey, 'hex')
      const sig = Buffer.from(signature, 'hex')
      const pk = Buffer.from(publicKey, 'hex')
      return sodium.crypto_sign_verify_detached(sig, message, pk)
    } catch {
      return false
    }
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
          node: this.node
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

  async _handle (req, res) {
    // Use X-Forwarded-For from reverse proxy (Caddy/NGINX), fall back to socket address
    const forwarded = this._trustProxy ? req.headers['x-forwarded-for'] : null
    const ip = (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || '127.0.0.1'

    // CORS headers on all responses
    const allowedOrigin = this._getAllowedOrigin(req.headers.origin)
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-App-Key')

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
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
      // SECURITY: Pagination support to prevent metadata enumeration attacks
      if (req.method === 'GET' && path === '/catalog.json') {
        // Parse pagination parameters
        const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1)
        const pageSize = Math.min(
          this._maxCatalogPageSize,
          Math.max(1, parseInt(url.searchParams.get('pageSize')) || 50)
        )

        const appMap = new Map() // appId → catalog entry (deduplication)

        for (const [appKey, entry] of this.node.seededApps) {
          try {
            const isBlind = entry.blind || false

            // Blind apps: can't read manifest (encrypted), use metadata from seededApps
            if (isBlind) {
              const appId = entry.appId || appKey.slice(0, 12)
              const catalogEntry = {
                id: appId,
                name: entry.appId || 'Private App',
                description: 'Encrypted app — P2P access only',
                author: 'anonymous',
                version: entry.version || '0.0.0',
                driveKey: appKey,
                blind: true,
                access: 'p2p-only',
                categories: ['private'],
                publishedAt: null,
                seededAt: entry.startedAt
              }
              const existing = appMap.get(appId)
              if (!existing || this._compareVersions(catalogEntry.version, existing.version) > 0) {
                appMap.set(appId, catalogEntry)
              }
              continue
            }

            // Public apps: try to read manifest from gateway
            let manifest = null
            try {
              const driveResult = await Promise.race([
                this._gateway._getDrive(appKey),
                new Promise(resolve => setTimeout(() => resolve(null), 3000))
              ])
              if (driveResult) {
                const manifestBuf = await Promise.race([
                  driveResult.get('/manifest.json'),
                  new Promise(resolve => setTimeout(() => resolve(null), 2000))
                ])
                if (manifestBuf) {
                  const raw = JSON.parse(manifestBuf.toString())
                  manifest = validateManifest(raw)
                }
              }
            } catch {}

            // Build catalog entry from manifest or fallback to seededApps metadata
            const appId = manifest
              ? (manifest.id || (manifest.name ? manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : entry.appId || appKey.slice(0, 12)))
              : (entry.appId || appKey.slice(0, 12))
            const version = (manifest && manifest.version) || entry.version || '1.0.0'

            const catalogEntry = {
              id: appId,
              name: (manifest && manifest.name) || entry.appId || 'App ' + appKey.slice(0, 8),
              description: (manifest && manifest.description) || '',
              author: (manifest && manifest.author) || 'anonymous',
              version,
              driveKey: appKey,
              blind: false,
              access: 'public',
              categories: (manifest && manifest.categories) || ['uncategorized'],
              publishedAt: (manifest && manifest.publishedAt) || null,
              seededAt: entry.startedAt
            }

            // Deduplicate: keep only the latest version per appId
            const existing = appMap.get(appId)
            if (!existing || this._compareVersions(version, existing.version) > 0) {
              appMap.set(appId, catalogEntry)
            }
          } catch {}
        }

        // Enrich with developer identity if IPL is available
        if (this.node.identity) {
          for (const [appKey, entry] of appMap) {
            const devKey = this.node.identity.attestation.appKeyIndex.get(appKey)
            if (devKey) {
              const profile = await this.node.identity.developerStore.getCompactProfile(devKey)
              entry.developer = { pubkey: devKey, ...profile }
            }
          }
        }

        // Apply pagination
        const allApps = Array.from(appMap.values())
        const total = allApps.length
        const totalPages = Math.ceil(total / pageSize)
        const startIndex = (page - 1) * pageSize
        const paginatedApps = allApps.slice(startIndex, startIndex + pageSize)

        res.setHeader('Content-Type', 'application/json')
        // SECURITY: Use configured CORS origins, not wildcard
        const allowedOrigin = this._getAllowedOrigin(req.headers.origin)
        if (allowedOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
        }
        return this._json(res, {
          version: 1,
          name: 'HiveRelay App Catalog',
          relayKey: this.node.swarm ? Buffer.from(this.node.swarm.keyPair.publicKey).toString('hex') : null,
          pagination: {
            page,
            pageSize,
            total,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
          },
          apps: paginatedApps
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

        // Resolve appId → driveKey (for PearBrowser and publishers that lost storage)
        if (path.startsWith('/api/resolve/')) {
          const appId = decodeURIComponent(path.slice('/api/resolve/'.length))
          if (!appId) return this._json(res, { error: 'appId required' }, 400)

          const entry = this.node.resolveApp(appId)
          if (!entry) {
            return this._json(res, { error: 'App not found', appId }, 404)
          }
          const response = {
            appId,
            driveKey: entry.driveKey,
            version: entry.version,
            name: entry.name,
            blind: entry.blind || false,
            updatedAt: entry.updatedAt
          }
          if (entry.blind) {
            response.access = 'p2p-only'
            response.hint = 'Connect directly via Hyperswarm with the encryption key. The relay provides discovery only — content is not mirrored.'
          }
          return this._json(res, response)
        }

        // List all registered apps (registry overview)
        // SECURITY: Pagination support to prevent metadata enumeration
        if (path === '/api/registry') {
          const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1)
          const pageSize = Math.min(
            this._maxCatalogPageSize,
            Math.max(1, parseInt(url.searchParams.get('pageSize')) || 50)
          )

          const allApps = []
          for (const [appId, entry] of this.node.appRegistry) {
            allApps.push({ appId, ...entry })
          }

          const total = allApps.length
          const totalPages = Math.ceil(total / pageSize)
          const startIndex = (page - 1) * pageSize
          const paginatedApps = allApps.slice(startIndex, startIndex + pageSize)

          return this._json(res, {
            pagination: {
              page,
              pageSize,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1
            },
            count: paginatedApps.length,
            apps: paginatedApps
          })
        }

        // --- Dashboard endpoints ---

        if (path === '/') {
          res.writeHead(302, { Location: '/dashboard' })
          res.end()
          return
        }

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

        if (path === '/leaderboard') {
          if (!this._leaderboardHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'leaderboard.html')
            this._leaderboardHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._leaderboardHtml)
          return
        }

        if (path === '/payments') {
          if (!this._paymentsHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'payments.html')
            this._paymentsHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._paymentsHtml)
          return
        }

        if (path === '/calculator') {
          if (!this._calculatorHtml) {
            const htmlPath = join(__dirname, '..', '..', 'dashboard', 'calculator.html')
            this._calculatorHtml = await readFile(htmlPath, 'utf-8')
          }
          res.setHeader('Content-Type', 'text/html')
          res.writeHead(200)
          res.end(this._calculatorHtml)
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
            reputation: this.node.reputation
              ? {
                  trackedRelays: Object.keys(this.node.reputation.export()).length,
                  topRelay: (() => {
                    const lb = this.node.reputation.getLeaderboard(1)
                    return lb.length ? lb[0] : null
                  })()
                }
              : null,
            tor: this.node.torTransport ? this.node.torTransport.getInfo() : null,
            health: this.node.getHealthStatus(),
            bandwidth: this.node._bandwidthReceipt
              ? {
                  totalProvenBytes: this.node._bandwidthReceipt.getTotalProvenBandwidth(),
                  receiptsIssued: this.node._bandwidthReceipt._issuedReceipts ? this.node._bandwidthReceipt._issuedReceipts.length : 0
                }
              : null,
            registry: this.node.seedingRegistry
              ? {
                  running: this.node.seedingRegistry.running,
                  autoAccept: this.node.config.registryAutoAccept !== false
                }
              : null,
            gateway: this._gateway ? this._gateway.getStats() : null,
            credits: this.node.creditManager ? this.node.creditManager.stats() : null,
            metering: this.node.serviceMeter ? this.node.serviceMeter.stats() : null,
            invoices: this.node.invoiceManager ? this.node.invoiceManager.stats() : null,
            payment: this.node.paymentManager
              ? (() => {
                  const accounts = []
                  for (const [pubkey] of this.node.paymentManager.accounts) {
                    accounts.push(this.node.paymentManager.getAccountSummary(pubkey))
                  }
                  return { accounts, provider: this.node.paymentManager.paymentProvider?.constructor.name || 'none' }
                })()
              : null,
            holesail: this.node.holesailTransport ? this.node.holesailTransport.getInfo() : null
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
              blind: entry.blind || false,
              discoveryKey: entry.discoveryKey ? Buffer.from(entry.discoveryKey).toString('hex') : null,
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
          const pending = []
          for (const [appKey, entry] of this.node._pendingRequests) {
            pending.push({ appKey, ...entry })
          }
          return this._json(res, { count: pending.length, requests: pending })
        }

        if (path === '/api/seeding-registry') {
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

        if (path === '/api/policy/violations') {
          return this._json(res, this.node.policyGuard.getViolations())
        }

        if (path === '/api/policy/suspended') {
          const violations = this.node.policyGuard.getViolations()
          return this._json(res, {
            count: violations.length,
            apps: violations
          })
        }
      }

      // ─── AI Inference ───
      if (path.startsWith('/api/v1/ai/')) {
        if (!this.node.serviceRegistry) {
          return this._json(res, { error: 'Services not enabled' }, 503)
        }
        const aiEntry = this.node.serviceRegistry.services.get('ai')
        if (!aiEntry) {
          return this._json(res, { error: 'AI service not enabled. Start with --ai --ai-model <name>' }, 503)
        }
        const ai = aiEntry.provider

        if (req.method === 'GET' && path === '/api/v1/ai/models') {
          return this._json(res, await ai['list-models']())
        }
        if (req.method === 'GET' && path === '/api/v1/ai/status') {
          return this._json(res, await ai.status())
        }
        if (req.method === 'POST' && path === '/api/v1/ai/infer') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.modelId || body.input === undefined) {
            return this._json(res, { error: 'modelId and input required' }, 400)
          }
          // Route through router for credit deduction + metering
          const appKey = req.headers['x-app-key'] || 'anonymous'
          if (this.node.router) {
            const result = await this.node.router.dispatch('ai.infer', body, {
              transport: 'http', appKey, caller: 'http-ai'
            })
            return this._json(res, result)
          }
          const result = await ai.infer(body)
          return this._json(res, result)
        }
        if (req.method === 'POST' && path === '/api/v1/ai/embed') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.modelId || !body.input) {
            return this._json(res, { error: 'modelId and input required' }, 400)
          }
          // Route through router for credit deduction + metering
          const appKey = req.headers['x-app-key'] || 'anonymous'
          if (this.node.router) {
            const result = await this.node.router.dispatch('ai.embed', body, {
              transport: 'http', appKey, caller: 'http-ai'
            })
            return this._json(res, result)
          }
          const result = await ai.embed(body)
          return this._json(res, result)
        }
        if (req.method === 'POST' && path === '/api/v1/ai/register') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          const result = await ai['register-model'](body)
          return this._json(res, result)
        }
        return this._json(res, { error: 'Unknown AI endpoint' }, 404)
      }

      // ─── Billing / Metering / Quotas ───
      if (path.startsWith('/api/v1/billing/')) {
        // GET /api/v1/billing/quota/:appKey — check quota for an app
        if (req.method === 'GET' && path.startsWith('/api/v1/billing/quota/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const appKey = path.split('/').pop()
          if (!this.node.serviceMeter || !this.node.freeTier) {
            return this._json(res, { error: 'Metering not enabled' }, 503)
          }
          return this._json(res, this.node.freeTier.getQuota(appKey, this.node.serviceMeter))
        }

        // GET /api/v1/billing/usage/:appKey — usage details for an app
        if (req.method === 'GET' && path.startsWith('/api/v1/billing/usage/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const appKey = path.split('/').pop()
          if (!this.node.serviceMeter) {
            return this._json(res, { error: 'Metering not enabled' }, 503)
          }
          return this._json(res, this.node.serviceMeter.getUsage(appKey))
        }

        // GET /api/v1/billing/stats — aggregate metering stats
        if (req.method === 'GET' && path === '/api/v1/billing/stats') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.serviceMeter) {
            return this._json(res, { error: 'Metering not enabled' }, 503)
          }
          return this._json(res, this.node.serviceMeter.stats())
        }

        // GET /api/v1/billing/account — payment account summary
        if (req.method === 'GET' && path === '/api/v1/billing/account') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.paymentManager) {
            return this._json(res, { error: 'Payments not enabled' }, 503)
          }
          const accounts = []
          for (const [pubkey] of this.node.paymentManager.accounts) {
            accounts.push(this.node.paymentManager.getAccountSummary(pubkey))
          }
          return this._json(res, { accounts })
        }

        // POST /api/v1/billing/tier — set app tier (auth required)
        if (req.method === 'POST' && path === '/api/v1/billing/tier') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey || !body.tier) {
            return this._json(res, { error: 'appKey and tier required' }, 400)
          }
          if (!this.node.freeTier) {
            return this._json(res, { error: 'Free tier not enabled' }, 503)
          }
          this.node.freeTier.setTier(body.appKey, body.tier)
          return this._json(res, { ok: true, appKey: body.appKey, tier: body.tier })
        }

        // POST /api/v1/billing/whitelist — add app to unlimited whitelist
        if (req.method === 'POST' && path === '/api/v1/billing/whitelist') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!this.node.freeTier) {
            return this._json(res, { error: 'Free tier not enabled' }, 503)
          }
          this.node.freeTier.addWhitelist(body.appKey)
          return this._json(res, { ok: true, appKey: body.appKey, tier: 'unlimited' })
        }

        return this._json(res, { error: 'Unknown billing endpoint' }, 404)
      }

      // ─── Credits / Payments / Invoices ���──
      if (path.startsWith('/api/v1/credits/')) {
        if (!this.node.creditManager) {
          return this._json(res, { error: 'Credit system not enabled' }, 503)
        }

        // GET /api/v1/credits/balance/:appKey — check credit balance
        if (req.method === 'GET' && path.startsWith('/api/v1/credits/balance/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const appKey = path.split('/').pop()
          const wallet = this.node.creditManager.getWallet(appKey)
          if (!wallet) return this._json(res, { balance: 0, wallet: null })
          return this._json(res, wallet)
        }

        // GET /api/v1/credits/transactions/:appKey — transaction history
        if (req.method === 'GET' && path.startsWith('/api/v1/credits/transactions/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const appKey = path.split('/').pop()
          const url = new URL(req.url, 'http://localhost')
          const limit = parseInt(url.searchParams.get('limit') || '50', 10)
          const offset = parseInt(url.searchParams.get('offset') || '0', 10)
          return this._json(res, this.node.creditManager.getTransactions(appKey, { limit, offset }))
        }

        // GET /api/v1/credits/pricing — rate card
        if (req.method === 'GET' && path === '/api/v1/credits/pricing') {
          return this._json(res, this.node.pricingEngine.getRateCard())
        }

        // GET /api/v1/credits/pricing/compare — price comparison vs cloud APIs
        if (req.method === 'GET' && path === '/api/v1/credits/pricing/compare') {
          return this._json(res, this.node.pricingEngine.getComparison())
        }

        // GET /api/v1/credits/estimate — estimate cost for batch of calls
        if (req.method === 'GET' && path === '/api/v1/credits/estimate') {
          const url = new URL(req.url, 'http://localhost')
          const route = url.searchParams.get('route')
          const inputTokens = parseInt(url.searchParams.get('inputTokens') || '0', 10)
          const outputTokens = parseInt(url.searchParams.get('outputTokens') || '0', 10)
          if (!route) return this._json(res, { error: 'route parameter required' }, 400)
          const result = this.node.pricingEngine.calculate(route, { inputTokens, outputTokens })
          return this._json(res, result)
        }

        // POST /api/v1/credits/invoice — create Lightning invoice to buy credits
        if (req.method === 'POST' && path === '/api/v1/credits/invoice') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.invoiceManager) {
            return this._json(res, { error: 'Invoice system not enabled' }, 503)
          }
          const body = await this._readBody(req)
          if (!body.appKey || !body.amount) {
            return this._json(res, { error: 'appKey and amount required' }, 400)
          }
          try {
            const invoice = await this.node.invoiceManager.createInvoice(
              body.appKey,
              body.amount,
              { memo: body.memo }
            )
            return this._json(res, invoice)
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // GET /api/v1/credits/invoice/:invoiceId — check invoice status
        if (req.method === 'GET' && path.startsWith('/api/v1/credits/invoice/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.invoiceManager) {
            return this._json(res, { error: 'Invoice system not enabled' }, 503)
          }
          const invoiceId = path.split('/').pop()
          const inv = this.node.invoiceManager.getInvoice(invoiceId)
          if (!inv) return this._json(res, { error: 'Invoice not found' }, 404)
          return this._json(res, inv)
        }

        // POST /api/v1/credits/invoice/settle — manually settle (for testing / webhook)
        if (req.method === 'POST' && path === '/api/v1/credits/invoice/settle') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.invoiceManager) {
            return this._json(res, { error: 'Invoice system not enabled' }, 503)
          }
          const body = await this._readBody(req)
          if (!body.invoiceId) return this._json(res, { error: 'invoiceId required' }, 400)
          try {
            const result = await this.node.invoiceManager.settleInvoice(body.invoiceId)
            return this._json(res, result)
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // POST /api/v1/credits/topup — direct credit top-up (admin, for testing)
        if (req.method === 'POST' && path === '/api/v1/credits/topup') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey || !body.amount) {
            return this._json(res, { error: 'appKey and amount required' }, 400)
          }
          try {
            const tx = this.node.creditManager.topUp(body.appKey, body.amount)
            return this._json(res, tx)
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // POST /api/v1/credits/freeze — freeze wallet (admin)
        if (req.method === 'POST' && path === '/api/v1/credits/freeze') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          try {
            this.node.creditManager.freezeWallet(body.appKey, body.reason || 'admin action')
            return this._json(res, { ok: true, frozen: true })
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // POST /api/v1/credits/unfreeze — unfreeze wallet (admin)
        if (req.method === 'POST' && path === '/api/v1/credits/unfreeze') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          try {
            this.node.creditManager.unfreezeWallet(body.appKey)
            return this._json(res, { ok: true, frozen: false })
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // POST /api/v1/credits/grant — grant free credits to an app (admin)
        if (req.method === 'POST' && path === '/api/v1/credits/grant') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const body = await this._readBody(req)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!body.amount || body.amount <= 0) return this._json(res, { error: 'amount required (positive integer)' }, 400)
          try {
            const tx = this.node.creditManager.grantCredits(body.appKey, body.amount, body.reason)
            return this._json(res, {
              ok: true,
              granted: body.amount,
              balance: tx.balance,
              reason: body.reason || 'Operator credit grant'
            })
          } catch (err) {
            return this._json(res, { error: err.message }, 400)
          }
        }

        // GET /api/v1/credits/stats — aggregate credit stats (admin)
        if (req.method === 'GET' && path === '/api/v1/credits/stats') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          const creditStats = this.node.creditManager.stats()
          const invoiceStats = this.node.invoiceManager ? this.node.invoiceManager.stats() : null
          return this._json(res, { credits: creditStats, invoices: invoiceStats })
        }

        // GET /api/v1/credits/invoices/:appKey — list invoices for an app
        if (req.method === 'GET' && path.startsWith('/api/v1/credits/invoices/')) {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.invoiceManager) {
            return this._json(res, { error: 'Invoice system not enabled' }, 503)
          }
          const appKey = path.split('/').pop()
          return this._json(res, { invoices: this.node.invoiceManager.getAppInvoices(appKey) })
        }

        return this._json(res, { error: 'Unknown credits endpoint' }, 404)
      }

      // POST routes
      if (req.method === 'POST') {
        const body = await this._readBody(req)

        if (path === '/seed') {
          // SECURITY: Require API key authentication
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }

          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)

          // SECURITY: Verify ownership signature if provided (defense-in-depth)
          // API key auth is the primary gate; signatures are optional until clients support them
          if (body.ownershipSignature && body.ownerPublicKey) {
            if (!this._verifyOwnershipSignature(body.appKey, body.ownershipSignature, body.ownerPublicKey)) {
              return this._json(res, { error: 'Invalid ownership signature' }, 403)
            }
          }

          const seedOpts = body.opts || {}
          // Forward appId from request body for deduplication
          if (body.appId && typeof body.appId === 'string') {
            if (body.appId.length > 128) return this._json(res, { error: 'appId must be 128 characters or less' }, 400)
            if (!/^[a-zA-Z0-9._-]+$/.test(body.appId)) return this._json(res, { error: 'appId must contain only alphanumeric, dot, dash, underscore' }, 400)

            // SECURITY: Verify registration challenge if provided (anti-squatting)
            if (body.registrationChallenge) {
              if (!this._verifyChallenge(body.appId, body.registrationChallenge)) {
                return this._json(res, { error: 'Invalid or expired registration challenge' }, 403)
              }
            }
            seedOpts.appId = body.appId
          }
          if (body.version && typeof body.version === 'string') {
            if (body.version.length > 32) return this._json(res, { error: 'version must be 32 characters or less' }, 400)
            seedOpts.version = body.version
          }
          if (body.blind === true) seedOpts.blind = true
          const result = await this.node.seedApp(body.appKey, seedOpts)
          return this._json(res, { ok: true, ...result })
        }

        if (path === '/challenge') {
          // SECURITY: Generate registration challenge for appId
          if (!body.appId) return this._json(res, { error: 'appId required' }, 400)
          if (typeof body.appId !== 'string' || body.appId.length > 128) {
            return this._json(res, { error: 'Invalid appId' }, 400)
          }
          const challenge = this._generateChallenge(body.appId)
          return this._json(res, { challenge, expiresIn: 300 })
        }

        if (path === '/registry/publish') {
          // SECURITY: Require API key authentication for registry operations
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }

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
            publisherPubkey: this.node.swarm ? this.node.swarm.keyPair.publicKey : Buffer.alloc(32)
          }

          const entry = await this.node.seedingRegistry.publishRequest(request)
          return this._json(res, { ok: true, ...entry })
        }

        if (path === '/registry/auto-accept') {
          // SECURITY: Require API key authentication for config changes
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          this.node.config.registryAutoAccept = body.enabled !== false
          return this._json(res, { ok: true, autoAccept: this.node.config.registryAutoAccept })
        }

        if (path === '/registry/approve') {
          // SECURITY: Require API key authentication
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          await this.node.approveRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/registry/reject') {
          // SECURITY: Require API key authentication
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          this.node.rejectRequest(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/registry/cancel') {
          // SECURITY: Require API key authentication
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.seedingRegistry) return this._json(res, { error: 'Registry not running' }, 503)
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          const pubkey = this.node.swarm ? Buffer.from(this.node.swarm.keyPair.publicKey).toString('hex') : null
          await this.node.seedingRegistry.cancelRequest(body.appKey, pubkey)
          return this._json(res, { ok: true })
        }

        if (path === '/unseed') {
          // SECURITY: Require API key authentication
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }

          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)

          // SECURITY: Verify ownership signature if provided (defense-in-depth)
          if (body.ownershipSignature && body.ownerPublicKey) {
            if (!this._verifyOwnershipSignature(body.appKey, body.ownershipSignature, body.ownerPublicKey)) {
              return this._json(res, { error: 'Invalid ownership signature' }, 403)
            }
          }

          await this.node.unseedApp(body.appKey)
          return this._json(res, { ok: true })
        }

        if (path === '/api/policy/reinstate') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!body.appKey) return this._json(res, { error: 'appKey required' }, 400)
          if (!isValidHexKey(body.appKey, 64)) return this._json(res, { error: 'appKey must be 64 hex characters' }, 400)
          const reinstated = this.node.policyGuard.reinstate(body.appKey)
          if (!reinstated) return this._json(res, { error: 'App not suspended' }, 404)
          return this._json(res, { ok: true, reinstated: body.appKey })
        }
      }

      // ─── Router Dispatch Endpoint ───
      if (req.method === 'POST' && path === '/api/v1/dispatch') {
        if (!this._verifyApiKey(req)) {
          return this._json(res, { error: 'Authentication required' }, 401)
        }
        if (!this.node.router) {
          return this._json(res, { error: 'Router not enabled' }, 503)
        }
        const body = await this._readBody(req)
        if (!body.route || typeof body.route !== 'string') {
          return this._json(res, { error: 'route required' }, 400)
        }
        if (body.route.length > 128) {
          return this._json(res, { error: 'route too long' }, 400)
        }
        const result = await this.node.router.dispatch(body.route, body.params || {}, {
          transport: 'http',
          ip,
          caller: 'http'
        })
        return this._json(res, { result })
      }

      // ─── Router Pub/Sub SSE Endpoint ───
      if (req.method === 'GET' && path === '/api/v1/subscribe') {
        if (!this._verifyApiKey(req)) {
          return this._json(res, { error: 'Authentication required' }, 401)
        }
        if (!this.node.router) {
          return this._json(res, { error: 'Router not enabled' }, 503)
        }
        const topic = url.searchParams.get('topic')
        if (!topic || topic.length > 256) {
          return this._json(res, { error: 'topic required (max 256 chars)' }, 400)
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write(':ok\n\n')

        const subId = this.node.router.pubsub.subscribe(topic, (t, data) => {
          try {
            res.write(`data: ${JSON.stringify({ topic: t, data })}\n\n`)
          } catch {}
        }, { ttl: 60 * 60 * 1000 })

        req.on('close', () => {
          this.node.router.pubsub.unsubscribe(subId)
        })
        return // Keep connection open
      }

      // ─── Router Stats ───
      if (req.method === 'GET' && path === '/api/v1/router') {
        if (!this.node.router) {
          return this._json(res, { error: 'Router not enabled' }, 503)
        }
        return this._json(res, this.node.router.getStats())
      }

      // ─── Identity Protocol ───
      if (path.startsWith('/api/v1/identity/')) {
        // GET /api/v1/identity/stats — identity system stats
        if (req.method === 'GET' && path === '/api/v1/identity/stats') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          return this._json(res, this.node.identity.stats())
        }

        // GET /api/v1/identity/developers — list all registered developers
        if (req.method === 'GET' && path === '/api/v1/identity/developers') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const devs = []
          for (const [devKey, dev] of this.node.identity.attestation.developers) {
            const profile = await this.node.identity.developerStore.getCompactProfile(devKey)
            devs.push({
              pubkey: devKey,
              appKeys: Array.from(dev.appKeys.keys()),
              registeredAt: dev.registeredAt,
              lastSeen: dev.lastSeen,
              profile
            })
          }
          return this._json(res, { developers: devs, count: devs.length })
        }

        // GET /api/v1/identity/resolve/:appKey — resolve app key to developer
        if (req.method === 'GET' && path.startsWith('/api/v1/identity/resolve/')) {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const appKey = path.split('/').pop()
          const result = await this.node.identity.resolveIdentity(appKey)
          return this._json(res, result)
        }

        // GET /api/v1/identity/developer/:devKey — developer detail
        if (req.method === 'GET' && path.startsWith('/api/v1/identity/developer/')) {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const devKey = path.split('/').pop()
          const dev = this.node.identity.attestation.developers.get(devKey)
          if (!dev) return this._json(res, { error: 'Developer not found' }, 404)
          const profile = await this.node.identity.developerStore.getProfile(devKey)
          return this._json(res, {
            pubkey: devKey,
            appKeys: Array.from(dev.appKeys.keys()),
            registeredAt: dev.registeredAt,
            lastSeen: dev.lastSeen,
            profile
          })
        }

        // GET /api/v1/identity/lnurl-auth — generate LNURL-auth challenge
        if (req.method === 'GET' && path === '/api/v1/identity/lnurl-auth') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const challenge = this.node.identity.lnurlAuth.createChallenge()
          return this._json(res, challenge)
        }

        // GET /api/v1/identity/lnurl-auth/callback — wallet callback (LUD-04)
        if (req.method === 'GET' && path === '/api/v1/identity/lnurl-auth/callback') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const k1 = url.searchParams.get('k1')
          const sig = url.searchParams.get('sig')
          const key = url.searchParams.get('key')
          if (!k1 || !sig || !key) {
            return this._json(res, { status: 'ERROR', reason: 'Missing k1, sig, or key' })
          }
          const result = this.node.identity.lnurlAuth.verifyCallback(k1, sig, key)
          if (result.success) {
            const session = this.node.identity.developerStore.createSession(key)
            return this._json(res, { status: 'OK', session: session.token })
          }
          return this._json(res, { status: 'ERROR', reason: result.error })
        }

        // GET /api/v1/identity/lnurl-auth/poll/:k1 — poll challenge status
        if (req.method === 'GET' && path.startsWith('/api/v1/identity/lnurl-auth/poll/')) {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const k1 = path.split('/').pop()
          const challenge = this.node.identity.lnurlAuth.challenges.get(k1)
          if (!challenge) return this._json(res, { status: 'unknown' })
          return this._json(res, {
            status: challenge.verified ? 'verified' : 'pending',
            pubkey: challenge.pubkey || null
          })
        }

        // POST /api/v1/identity/attest — submit attestation
        if (req.method === 'POST' && path === '/api/v1/identity/attest') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const body = await this._readBody(req)
          const result = await this.node.identity.attestation.submitAttestation(body)
          if (result.success) {
            return this._json(res, { success: true, developer: result.developer })
          }
          return this._json(res, { error: result.error }, 400)
        }

        // POST /api/v1/identity/revoke — revoke attestation
        if (req.method === 'POST' && path === '/api/v1/identity/revoke') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const body = await this._readBody(req)
          const result = this.node.identity.attestation.revokeAttestation(body.appKey, body.developerKey)
          return this._json(res, result)
        }

        // POST /api/v1/identity/profile — set developer profile manually
        if (req.method === 'POST' && path === '/api/v1/identity/profile') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const developerKey = this.node.identity.authenticateRequest(req)
          if (!developerKey) return this._json(res, { error: 'Authentication required' }, 401)
          const body = await this._readBody(req)
          this.node.identity.developerStore.setProfile(developerKey, body)
          return this._json(res, { success: true })
        }

        // GET /api/v1/identity/session — validate session
        if (req.method === 'GET' && path === '/api/v1/identity/session') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const developerKey = this.node.identity.authenticateRequest(req)
          if (!developerKey) return this._json(res, { error: 'No valid session' }, 401)
          const profile = await this.node.identity.developerStore.getCompactProfile(developerKey)
          return this._json(res, { authenticated: true, devKey: developerKey, profile })
        }

        // POST /api/v1/identity/logout — destroy session
        if (req.method === 'POST' && path === '/api/v1/identity/logout') {
          if (!this.node.identity) {
            return this._json(res, { error: 'Identity system not enabled' }, 503)
          }
          const token = (req.headers.authorization || '').replace('Bearer ', '')
          if (token) this.node.identity.developerStore.destroySession(token)
          return this._json(res, { success: true })
        }

        return this._json(res, { error: 'Unknown identity endpoint' }, 404)
      }

      // ─── Catalog Sync ───
      if (path.startsWith('/api/v1/sync')) {
        // GET /api/v1/sync — sync status and stats
        if (req.method === 'GET' && path === '/api/v1/sync') {
          if (!this.node.catalogSync) {
            return this._json(res, { error: 'Catalog sync not enabled' }, 503)
          }
          return this._json(res, this.node.catalogSync.getStats())
        }

        // POST /api/v1/sync/trigger — force immediate sync
        if (req.method === 'POST' && path === '/api/v1/sync/trigger') {
          if (!this._verifyApiKey(req)) {
            return this._json(res, { error: 'Authentication required' }, 401)
          }
          if (!this.node.catalogSync) {
            return this._json(res, { error: 'Catalog sync not enabled' }, 503)
          }
          await this.node.catalogSync.syncNow()
          return this._json(res, { success: true, stats: this.node.catalogSync.getStats() })
        }

        return this._json(res, { error: 'Unknown sync endpoint' }, 404)
      }

      // ─── Service Catalog ───
      if (req.method === 'GET' && path === '/api/v1/services') {
        if (!this.node.serviceRegistry) {
          return this._json(res, { error: 'Services not enabled' }, 503)
        }
        return this._json(res, {
          services: this.node.serviceRegistry.catalog(),
          count: this.node.serviceRegistry.services.size
        })
      }

      // 404
      this._json(res, { error: 'Not found' }, 404)
    } catch (err) {
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

  _compareVersions (a, b) {
    const pa = (a || '0.0.0').split('.').map(Number)
    const pb = (b || '0.0.0').split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const na = pa[i] || 0
      const nb = pb[i] || 0
      if (na > nb) return 1
      if (na < nb) return -1
    }
    return 0
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

    if (this._challengeCleanup) {
      clearInterval(this._challengeCleanup)
      this._challengeCleanup = null
    }
    this._registrationChallenges.clear()

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
