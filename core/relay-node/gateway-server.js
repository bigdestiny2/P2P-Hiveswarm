/**
 * Gateway Server — data-plane HTTP server for Hyperdrive content serving.
 *
 * Separated from the control-plane RelayAPI so heavy file traffic cannot
 * starve management endpoints. Serves:
 *   - GET /v1/hyper/:key/*  — HTTP gateway for Hyperdrive content
 *   - GET /catalog.json     — public content catalog (typed)
 *   - GET /health           — simple liveness check for load balancers
 *
 * No auth required — all routes are public, read-only. Privacy tiers are
 * still enforced by the HyperGateway itself.
 *
 * Defaults to 0.0.0.0:9200 (the control plane defaults to 127.0.0.1:9100).
 * When `gatewayPort === apiPort` the server is NOT started — the RelayAPI
 * handles the gateway routes inline (backward compatibility).
 */

import { createServer } from 'http'
import { EventEmitter } from 'events'
import { HyperGateway } from '../../compute/gateway/hyper-gateway.js'
import { normalizeContentType } from '../constants.js'

const DEFAULT_GATEWAY_PORT = 9200

// Gateway rate limit — higher than the control plane (file serving is bursty).
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX = 600 // 10 req/sec sustained per IP

export class GatewayServer extends EventEmitter {
  constructor (relayNode, opts = {}) {
    super()
    this.node = relayNode
    this.port = opts.gatewayPort || DEFAULT_GATEWAY_PORT
    this.host = opts.gatewayHost || '0.0.0.0'
    this.corsOrigins = opts.corsOrigins || []
    this.trustProxy = opts.trustProxy || false
    this.server = null
    this._gateway = opts.gateway || new HyperGateway(relayNode, { store: relayNode.store })
    this._ownsGateway = !opts.gateway
    this._rateLimits = new Map()
    this._rateLimitCleanup = null
  }

  get gateway () {
    return this._gateway
  }

  async start () {
    this.server = createServer((req, res) => this._handle(req, res))

    this._rateLimitCleanup = setInterval(() => {
      const now = Date.now()
      for (const [ip, entry] of this._rateLimits) {
        if (now > entry.resetAt) this._rateLimits.delete(ip)
      }
    }, 120_000)
    if (this._rateLimitCleanup.unref) this._rateLimitCleanup.unref()

    return new Promise((resolve, reject) => {
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        this.emit('started', { port: this.port })
        resolve()
      })
    })
  }

  async stop () {
    if (this._rateLimitCleanup) {
      clearInterval(this._rateLimitCleanup)
      this._rateLimitCleanup = null
    }
    if (this.server) {
      await new Promise(resolve => this.server.close(resolve))
      this.server = null
    }
  }

  _getClientIP (req) {
    if (this.trustProxy) {
      const xff = req.headers['x-forwarded-for']
      if (xff) {
        const first = xff.split(',')[0].trim()
        if (first) return first
      }
      const realIP = req.headers['x-real-ip']
      if (realIP) return realIP.trim()
    }
    return req.socket.remoteAddress || ''
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

  _getAllowedOrigin (origin) {
    if (!origin) return null
    if (this.corsOrigins.includes('*')) return '*'
    if (this.corsOrigins.includes(origin)) return origin
    return null
  }

  async _handle (req, res) {
    const ip = this._getClientIP(req) || '127.0.0.1'
    const requestOrigin = req.headers.origin

    const allowedOrigin = this._getAllowedOrigin(requestOrigin)
    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      res.writeHead(204)
      res.end()
      return
    }

    if (!this._checkRateLimit(ip)) {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Retry-After', '60')
      res.writeHead(429)
      res.end(JSON.stringify({ error: 'Too many requests' }) + '\n')
      return
    }

    let path = ''
    try {
      path = new URL(req.url, `http://0.0.0.0:${this.port}`).pathname
    } catch {
      res.writeHead(400)
      res.end()
      return
    }

    try {
      // Hyperdrive gateway — the primary data-plane route
      if (path.startsWith('/v1/hyper/')) {
        return this._gateway.handle(req, res)
      }

      // Public catalog — safe to serve on the data plane
      if (req.method === 'GET' && path === '/catalog.json') {
        return this._serveCatalog(req, res)
      }

      // Simple liveness check for load balancers
      if (req.method === 'GET' && (path === '/health' || path === '/')) {
        res.setHeader('Content-Type', 'application/json')
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, service: 'gateway' }) + '\n')
        return
      }

      res.setHeader('Content-Type', 'application/json')
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Not found' }) + '\n')
    } catch (err) {
      this.emit('error', err)
      res.setHeader('Content-Type', 'application/json')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal error' }) + '\n')
    }
  }

  _serveCatalog (req, res) {
    const url = new URL(req.url, `http://0.0.0.0:${this.port}`)
    const page = Math.max(parseInt(url.searchParams.get('page')) || 1, 1)
    const pageSize = Math.min(
      Math.max(parseInt(url.searchParams.get('pageSize')) || 50, 1),
      200
    )
    const typeFilter = normalizeContentType(url.searchParams.get('type'), null)

    const registry = this.node.appRegistry
    const catalog = registry ? registry.catalog() : { apps: [], drives: [], resources: [], datasets: [], media: [] }

    let items = []
    if (typeFilter === 'app') items = catalog.apps || []
    else if (typeFilter === 'drive') items = catalog.drives || []
    else if (typeFilter === 'dataset') items = catalog.datasets || []
    else if (typeFilter === 'media') items = catalog.media || []
    else {
      items = [
        ...(catalog.apps || []),
        ...(catalog.drives || []),
        ...(catalog.resources || []),
        ...(catalog.datasets || []),
        ...(catalog.media || [])
      ]
    }

    const start = (page - 1) * pageSize
    const paginated = items.slice(start, start + pageSize)

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'public, max-age=30')
    res.writeHead(200)
    res.end(JSON.stringify({
      items: paginated,
      page,
      pageSize,
      total: items.length,
      hasMore: start + pageSize < items.length
    }) + '\n')
  }
}
