/**
 * DHT-Relay WebSocket transport — lets browsers tunnel HyperDHT lookups
 * through this relay over a WebSocket.
 *
 * Browsers can't speak UDP, so they can't do native HyperDHT operations
 * (peer discovery, hole-punch announce, etc.) themselves. This transport
 * exposes the relay's HyperDHT instance to browser clients via a framed
 * WebSocket protocol — the browser instantiates `new DHT(stream)` from
 * `@hyperswarm/dht-relay` and gets a working DHT API end-to-end.
 *
 * Distinct from the existing Hypercore-over-WebSocket transport
 * (`transports/websocket/`), which carries replication streams. This one
 * carries DHT control traffic.
 *
 * Usage:
 *   const dhtRelay = new DHTRelayWS({ dht: swarm.dht, port: 8766 })
 *   await dhtRelay.start()
 */

import { EventEmitter } from 'events'
import { WebSocketServer } from 'ws'
import { relay } from '@hyperswarm/dht-relay'
import Stream from '@hyperswarm/dht-relay/ws'

const DEFAULT_PORT = 8766
const DEFAULT_CONNECTIONS_PER_MINUTE_PER_IP = 10
const DEFAULT_MAX_CONCURRENT_PER_IP = 5
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000
const DEFAULT_STALE_AFTER_MS = 5 * 60_000

export class DHTRelayWS extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.dht - HyperDHT instance to expose (typically swarm.dht)
   * @param {number} [opts.port]
   * @param {string} [opts.host]
   * @param {number} [opts.maxConnections]
   * @param {object} [opts.rateLimit]
   * @param {number} [opts.rateLimit.connectionsPerMinutePerIp=10]
   * @param {number} [opts.rateLimit.maxConcurrentPerIp=5]
   * @param {number} [opts.rateLimit.windowMs=60000] - token bucket refill window
   * @param {number} [opts.rateLimit.cleanupIntervalMs=60000] - how often we sweep stale entries
   * @param {number} [opts.rateLimit.staleAfterMs=300000] - drop entries with no activity for this long
   */
  constructor (opts = {}) {
    super()
    if (!opts.dht) throw new Error('DHTRelayWS: dht is required')
    this.dht = opts.dht
    this.port = opts.port || DEFAULT_PORT
    this.host = opts.host || '0.0.0.0'
    this.maxConnections = opts.maxConnections || 256

    const rl = opts.rateLimit || {}
    this.rateLimit = {
      connectionsPerMinutePerIp: rl.connectionsPerMinutePerIp || DEFAULT_CONNECTIONS_PER_MINUTE_PER_IP,
      maxConcurrentPerIp: rl.maxConcurrentPerIp || DEFAULT_MAX_CONCURRENT_PER_IP,
      windowMs: rl.windowMs || DEFAULT_RATE_LIMIT_WINDOW_MS,
      cleanupIntervalMs: rl.cleanupIntervalMs || DEFAULT_CLEANUP_INTERVAL_MS,
      staleAfterMs: rl.staleAfterMs || DEFAULT_STALE_AFTER_MS
    }

    this.server = null
    this.connections = new Set()
    this.running = false
    this._totalConnectionsServed = 0
    this._totalRateLimited = 0
    // Map<ip, { tokens, lastRefill, concurrent, lastSeen }>
    this._ipBuckets = new Map()
    this._cleanupTimer = null
  }

  // Token-bucket check + decrement. Returns null if allowed, or a string
  // reason ('connections-per-minute' | 'max-concurrent') if rate-limited.
  _checkRateLimit (ip) {
    const now = Date.now()
    const cap = this.rateLimit.connectionsPerMinutePerIp
    const window = this.rateLimit.windowMs
    let bucket = this._ipBuckets.get(ip)
    if (!bucket) {
      bucket = { tokens: cap, lastRefill: now, concurrent: 0, lastSeen: now }
      this._ipBuckets.set(ip, bucket)
    }

    // Refill tokens based on elapsed time. Continuous refill: a full window
    // of inactivity restores the bucket to `cap`.
    const elapsed = now - bucket.lastRefill
    if (elapsed > 0) {
      const refill = (elapsed / window) * cap
      bucket.tokens = Math.min(cap, bucket.tokens + refill)
      bucket.lastRefill = now
    }
    bucket.lastSeen = now

    if (bucket.concurrent >= this.rateLimit.maxConcurrentPerIp) {
      return 'max-concurrent'
    }
    if (bucket.tokens < 1) {
      return 'connections-per-minute'
    }

    bucket.tokens -= 1
    bucket.concurrent += 1
    return null
  }

  _releaseConnection (ip) {
    const bucket = this._ipBuckets.get(ip)
    if (!bucket) return
    bucket.concurrent = Math.max(0, bucket.concurrent - 1)
    bucket.lastSeen = Date.now()
  }

  _cleanupStaleBuckets () {
    const now = Date.now()
    const stale = this.rateLimit.staleAfterMs
    for (const [ip, bucket] of this._ipBuckets) {
      if (bucket.concurrent === 0 && (now - bucket.lastSeen) > stale) {
        this._ipBuckets.delete(ip)
      }
    }
  }

  async start () {
    if (this.running) return

    this.server = new WebSocketServer({
      port: this.port,
      host: this.host,
      perMessageDeflate: false, // dht-relay carries its own framed binary
      // Reject rate-limited clients at HTTP upgrade time (before the WS
      // upgrade completes) so the client sees an HTTP error rather than an
      // open-then-close cycle. The connection-event handler still enforces
      // the global maxConnections cap.
      verifyClient: (info, cb) => {
        const ip = info.req.socket.remoteAddress
        const rateLimitReason = this._checkRateLimit(ip)
        if (rateLimitReason) {
          this._totalRateLimited++
          this.emit('rate-limited', { ip, reason: rateLimitReason })
          const status = rateLimitReason === 'max-concurrent' ? 503 : 429
          cb(false, status, rateLimitReason)
          return
        }
        cb(true)
      }
    })

    await new Promise((resolve, reject) => {
      this.server.on('listening', resolve)
      this.server.on('error', reject)
    })

    this.server.on('connection', (socket, req) => {
      const ip = req.socket.remoteAddress

      if (this.connections.size >= this.maxConnections) {
        // Rate-limit already accepted us in verifyClient; release the
        // concurrency slot we reserved before refusing on the global cap.
        this._releaseConnection(ip)
        socket.close(1013, 'DHT_RELAY_AT_CAPACITY')
        return
      }

      this.connections.add(socket)
      this._totalConnectionsServed++

      const info = {
        type: 'dht-relay-ws',
        remoteAddress: ip,
        remotePort: req.socket.remotePort
      }

      // Hand the socket off to dht-relay. It speaks its own framed
      // protocol over the WebSocket and proxies DHT operations to our
      // local HyperDHT instance.
      try {
        relay(this.dht, new Stream(false, socket))
      } catch (err) {
        this.emit('relay-error', { error: err, info })
        try { socket.close(1011, 'DHT_RELAY_INIT_FAILED') } catch (_) {}
        this.connections.delete(socket)
        this._releaseConnection(ip)
        return
      }

      socket.on('close', () => {
        this.connections.delete(socket)
        this._releaseConnection(ip)
        this.emit('client-disconnected', info)
      })

      socket.on('error', (err) => {
        this.emit('client-error', { error: err, info })
      })

      this.emit('client-connected', info)
    })

    this._cleanupTimer = setInterval(
      () => this._cleanupStaleBuckets(),
      this.rateLimit.cleanupIntervalMs
    )
    if (this._cleanupTimer.unref) this._cleanupTimer.unref()

    this.running = true
    this.emit('started', { port: this.port, host: this.host })
  }

  async stop () {
    if (!this.running) return
    this.running = false

    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }

    for (const socket of this.connections) {
      try { socket.close(1001, 'SERVER_SHUTDOWN') } catch (_) {}
    }
    this.connections.clear()
    this._ipBuckets.clear()

    await new Promise((resolve) => {
      this.server.close(() => resolve())
    })
    this.server = null
    this.emit('stopped')
  }

  getStats () {
    return {
      running: this.running,
      port: this.port,
      host: this.host,
      activeConnections: this.connections.size,
      totalConnectionsServed: this._totalConnectionsServed,
      totalRateLimited: this._totalRateLimited,
      maxConnections: this.maxConnections,
      rateLimit: {
        connectionsPerMinutePerIp: this.rateLimit.connectionsPerMinutePerIp,
        maxConcurrentPerIp: this.rateLimit.maxConcurrentPerIp
      }
    }
  }
}
