/**
 * Relay Tunnel — Remote Access for Private Mode
 *
 * Allows HomeHive (private mode) nodes to be reached from outside
 * the LAN by tunneling through a trusted public relay node.
 *
 * Architecture:
 *   1. Private node connects to a chosen public relay (outbound only)
 *   2. Establishes a persistent Protomux channel for tunnel control
 *   3. Public relay forwards authenticated connections back through the tunnel
 *   4. All traffic is end-to-end encrypted (Noise protocol from Hyperswarm)
 *
 * The private node never opens inbound ports or joins the public DHT.
 * The public relay only forwards — it cannot read the tunneled data.
 *
 * Trust model:
 *   - Private node must trust the relay to forward (not snoop or drop)
 *   - Relay sees connection metadata (who connects) but not content
 *   - Device allowlist is enforced at the private node, not the relay
 */

import { EventEmitter } from 'events'
import HyperDHT from 'hyperdht'
import b4a from 'b4a'

export class RelayTunnel extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.relayPubkey = opts.relayPubkey || null // Hex string of trusted relay
    this.keyPair = opts.keyPair || null
    this.reconnectInterval = opts.reconnectInterval || 30_000
    this.maxReconnectAttempts = opts.maxReconnectAttempts || 10

    this._dht = null
    this._socket = null
    this._connected = false
    this._reconnectTimer = null
    this._reconnectAttempts = 0
    this._destroyed = false
  }

  /**
   * Start the tunnel — connect to the trusted relay.
   * Uses a direct HyperDHT connection (not Hyperswarm) to avoid
   * joining any discovery topics.
   */
  async start () {
    if (!this.relayPubkey) {
      throw new Error('TUNNEL_NO_RELAY: set relayPubkey to connect')
    }
    if (!this.keyPair) {
      throw new Error('TUNNEL_NO_KEYPAIR')
    }

    this._dht = new HyperDHT({ bootstrap: [] })
    await this._connect()
  }

  async _connect () {
    if (this._destroyed) return

    try {
      const relayKey = b4a.from(this.relayPubkey, 'hex')

      this._socket = this._dht.connect(relayKey, {
        keyPair: this.keyPair
      })

      this._socket.on('open', () => {
        this._connected = true
        this._reconnectAttempts = 0
        this.emit('connected', { relay: this.relayPubkey })
      })

      this._socket.on('close', () => {
        this._connected = false
        this.emit('disconnected', { relay: this.relayPubkey })
        this._scheduleReconnect()
      })

      this._socket.on('error', (err) => {
        this.emit('error', { relay: this.relayPubkey, error: err.message })
        if (!this._connected) {
          this._scheduleReconnect()
        }
      })

      // The socket is a duplex stream — the relay node will multiplex
      // tunneled connections over this single stream using Protomux
      this._socket.on('data', (data) => {
        this.emit('data', data)
      })
    } catch (err) {
      this.emit('connect-error', { error: err.message })
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect () {
    if (this._destroyed) return
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('max-reconnects', { attempts: this._reconnectAttempts })
      return
    }

    this._reconnectAttempts++
    const delay = Math.min(
      this.reconnectInterval * Math.pow(1.5, this._reconnectAttempts - 1),
      5 * 60_000 // max 5 minutes
    )

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connect()
    }, delay)
    if (this._reconnectTimer.unref) this._reconnectTimer.unref()

    this.emit('reconnecting', {
      attempt: this._reconnectAttempts,
      delayMs: Math.round(delay)
    })
  }

  /**
   * Write data through the tunnel to the relay.
   */
  write (data) {
    if (!this._socket || !this._connected) {
      throw new Error('TUNNEL_NOT_CONNECTED')
    }
    this._socket.write(data)
  }

  get connected () {
    return this._connected
  }

  getInfo () {
    return {
      relay: this.relayPubkey,
      connected: this._connected,
      reconnectAttempts: this._reconnectAttempts
    }
  }

  async stop () {
    this._destroyed = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    if (this._socket) {
      this._socket.destroy()
      this._socket = null
    }
    if (this._dht) {
      await this._dht.destroy()
      this._dht = null
    }
    this._connected = false
    this.emit('stopped')
  }
}
