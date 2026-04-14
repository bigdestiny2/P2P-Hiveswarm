/**
 * Holesail API Tunnel Transport
 *
 * Exposes the relay's HTTP API through the Hyperswarm DHT via Holesail,
 * making the API reachable without port forwarding. Designed for
 * home-network relay operators behind NAT.
 *
 * The transport creates a HolesailServer that tunnels the local API port
 * (default 9100) through the DHT. Remote nodes connect using the
 * holesail connection key via HolesailClient.
 *
 * Key persistence: The holesail seed is derived deterministically from
 * the relay's Hyperswarm keypair, so the connection key survives restarts.
 */

import { EventEmitter } from 'events'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

export class HolesailTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.apiPort = opts.apiPort || 9100
    this.apiHost = opts.host || '127.0.0.1'
    this.seed = opts.seed || null // 32-byte hex string for deterministic keys
    this.connectionKey = null
    this.running = false
    this._server = null
  }

  async start () {
    if (this.running) return

    const HolesailServer = require('holesail-server')

    this._server = new HolesailServer()

    // Generate deterministic keypair from seed
    if (this.seed) {
      this._server.generateKeyPair(this.seed)
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Holesail server start timed out after 30s'))
      }, 30000)

      this._server.start(
        {
          port: this.apiPort,
          host: this.apiHost,
          seed: this.seed
        },
        () => {
          clearTimeout(timer)
          resolve()
        }
      )
    })

    this.connectionKey = this._server.key
    this.running = true

    this.emit('started', { connectionKey: this.connectionKey })
  }

  async stop () {
    if (!this.running) return
    this.running = false

    if (this._server) {
      try {
        await this._server.destroy()
      } catch {}
      this._server = null
    }

    this.connectionKey = null
    this.emit('stopped')
  }

  getInfo () {
    return {
      running: this.running,
      connectionKey: this.connectionKey,
      apiPort: this.apiPort
    }
  }
}
