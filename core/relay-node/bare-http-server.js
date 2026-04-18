/**
 * Minimal HTTP surface for the Bare relay.
 *
 * Uses `bare-http1` (Bare's built-in HTTP/1.1 implementation) to provide a
 * small subset of the Node relay's HTTP API:
 *
 *   GET /health          — liveness check
 *   GET /status          — node status JSON
 *   GET /catalog.json    — seeded apps catalog
 *   GET /api/overview    — dashboard overview
 *   GET /api/peers       — connected peers
 *
 * Intentionally limited to read-only endpoints — no management routes, no
 * gateway, no dashboard HTML. Operators who need those should use the Node
 * version alongside a Pear-native relay (the Node one handles operator UX,
 * the Bare one handles the 24/7 hot path).
 */

import http from 'bare-http1'
import b4a from 'b4a'

export class BareHttpServer {
  constructor (relay, opts = {}) {
    this.relay = relay
    this.port = opts.port || 9100
    this.host = opts.host || '0.0.0.0'
    this.server = null
  }

  async start () {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res))
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        resolve({ port: this.port, host: this.host })
      })
    })
  }

  async stop () {
    if (!this.server) return
    return new Promise((resolve) => {
      this.server.close(() => { this.server = null; resolve() })
    })
  }

  _json (res, body, status = 200) {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.writeHead(status)
    res.end(JSON.stringify(body) + '\n')
  }

  _handle (req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
    const path = url.pathname

    if (path === '/health') {
      return this._json(res, { ok: true, runtime: 'bare', uptime: this._uptime() })
    }

    if (path === '/status' || path === '/api/overview') {
      return this._json(res, this._overview())
    }

    if (path === '/catalog.json') {
      return this._json(res, this._catalog())
    }

    if (path === '/api/peers') {
      return this._json(res, this._peers())
    }

    // 404
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Not found', path }) + '\n')
  }

  _uptime () {
    if (!this.relay.startedAt) return 0
    const ms = Date.now() - this.relay.startedAt
    const s = Math.floor(ms / 1000)
    return {
      ms,
      human: s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'
    }
  }

  _overview () {
    const pk = this.relay.publicKey ? b4a.toString(this.relay.publicKey, 'hex') : null
    return {
      runtime: 'bare',
      publicKey: pk,
      uptime: this._uptime(),
      region: (this.relay.config.regions || ['unknown'])[0],
      connections: this.relay.connections.size,
      seededApps: this.relay.appRegistry ? this.relay.appRegistry.apps.size : 0,
      storage: {
        used: this.relay.seeder ? this.relay.seeder.totalBytesStored || 0 : 0,
        max: this.relay.config.maxStorageBytes
      },
      services: this.relay.serviceRegistry
        ? { count: this.relay.serviceRegistry.services.size }
        : null,
      errors: 0
    }
  }

  _catalog () {
    const buckets = { apps: [], drives: [], resources: [], datasets: [], media: [] }
    if (!this.relay.appRegistry) return buckets
    const items = this.relay.appRegistry.catalog()
    for (const item of items) {
      const bucket = buckets[item.type + 's'] || buckets.resources
      bucket.push(item)
    }
    return buckets
  }

  _peers () {
    const peers = []
    for (const [conn, entry] of this.relay.connections) {
      const pk = conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : null
      peers.push({ publicKey: pk, lastActivity: entry.lastActivity })
    }
    return { count: peers.length, peers }
  }
}
