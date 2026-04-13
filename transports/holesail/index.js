/**
 * Holesail Transport
 *
 * Exposes relay services through Holesail TCP/UDP tunnels over Hyperswarm.
 * Enables peers to connect to the relay without knowing its IP — they only
 * need the Holesail connection key (z32-encoded public key).
 *
 * Modes:
 *   - Server: Tunnels a local port (e.g., the HTTP API) through a Holesail
 *     server, making it accessible via a connection key on the DHT.
 *   - Connector: Accepts raw HyperDHT stream connections and emits them as
 *     Duplex streams for the relay's _onConnection() handler (P2P protocols).
 *
 * How it works:
 *   1. HolesailTransport creates a HyperDHT server with a deterministic keypair
 *   2. The keypair is derived from a seed (configurable or random)
 *   3. Incoming HyperDHT connections are proxied to the local API port (tunnel mode)
 *   4. OR emitted as raw streams for direct Protomux attachment (connector mode)
 *   5. The connection key is published — apps use it to reach the relay
 *
 * Usage:
 *   hiverelay start --holesail --holesail-port 9100
 *   → Exposes port 9100 via Holesail tunnel
 *   → Prints connection key for clients to use
 */

import { EventEmitter } from 'events'
import { createHash, randomBytes } from 'crypto'
import b4a from 'b4a'

export class HolesailTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.port = opts.port || 9100
    this.host = opts.host || '127.0.0.1'
    this.seed = opts.seed || null
    this.secure = opts.secure || false
    this.udp = opts.udp || false
    this.connectorMode = opts.connectorMode || false
    this.maxConnections = opts.maxConnections || 256

    this.holesail = null
    this.connectionKey = null
    this.connectionUrl = null
    this.running = false
    this._connections = new Set()
  }

  async start () {
    if (this.running) return

    // Dynamic import — holesail is a CJS package
    const Holesail = (await import('holesail')).default || (await import('holesail'))

    const seed = this.seed || randomBytes(32).toString('hex')

    if (this.connectorMode) {
      // Connector mode: raw HyperDHT server, emit streams directly
      await this._startConnector(seed)
    } else {
      // Tunnel mode: proxy connections to local port via Holesail
      this.holesail = new Holesail({
        server: true,
        port: this.port,
        host: this.host,
        key: seed,
        secure: this.secure,
        udp: this.udp
      })

      await this.holesail.ready()

      const info = this.holesail.info
      this.connectionKey = info.key
      this.connectionUrl = info.url
    }

    this.running = true

    this.emit('started', {
      mode: this.connectorMode ? 'connector' : 'tunnel',
      port: this.port,
      host: this.host,
      connectionKey: this.connectionKey,
      connectionUrl: this.connectionUrl,
      secure: this.secure,
      udp: this.udp
    })
  }

  /**
   * Start in connector mode — raw HyperDHT server that emits streams.
   * These streams get piped into RelayNode._onConnection() for full
   * Protomux protocol support (seed, circuit, services).
   */
  async _startConnector (seed) {
    const HyperDHT = (await import('hyperdht')).default || (await import('hyperdht'))
    const z32 = (await import('z32')).default || (await import('z32'))

    this._dht = new HyperDHT()
    const seedBuf = Buffer.from(createHash('sha256').update(seed).digest())
    this._keyPair = HyperDHT.keyPair(seedBuf)

    const firewall = this.secure
      ? (remotePublicKey) => {
          return !b4a.equals(remotePublicKey, this._keyPair.publicKey)
        }
      : false

    this._server = this._dht.createServer({
      firewall,
      reusableSocket: true
    }, (stream) => {
      if (this._connections.size >= this.maxConnections) {
        stream.destroy()
        return
      }

      this._connections.add(stream)

      stream.on('close', () => {
        this._connections.delete(stream)
      })

      stream.on('error', () => {
        this._connections.delete(stream)
      })

      // Emit as a standard connection — RelayNode._onConnection() handles the rest
      this.emit('connection', stream, {
        type: 'holesail',
        remotePublicKey: stream.remotePublicKey,
        handshakeHash: stream.handshakeHash
      })
    })

    await this._server.listen(this._keyPair)
    this.connectionKey = z32.encode(this._keyPair.publicKey)
    this.connectionUrl = (this.secure ? 'hs://s000' : 'hs://0000') + this.connectionKey
  }

  /**
   * Get transport info for status endpoints.
   */
  getInfo () {
    return {
      running: this.running,
      mode: this.connectorMode ? 'connector' : 'tunnel',
      connectionKey: this.connectionKey,
      connectionUrl: this.connectionUrl,
      port: this.port,
      host: this.host,
      secure: this.secure,
      udp: this.udp,
      activeConnections: this._connections.size
    }
  }

  async stop () {
    if (!this.running) return

    // Destroy all active connections
    for (const conn of this._connections) {
      try { conn.destroy() } catch {}
    }
    this._connections.clear()

    if (this.holesail) {
      try { await this.holesail.close() } catch {}
      this.holesail = null
    }

    if (this._server) {
      try { await this._server.close() } catch {}
      this._server = null
    }

    if (this._dht) {
      try { await this._dht.destroy() } catch {}
      this._dht = null
    }

    this.running = false
    this.emit('stopped')
  }
}
