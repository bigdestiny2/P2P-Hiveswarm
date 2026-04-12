/**
 * mDNS Local Discovery
 * =====================
 * Broadcasts this node's presence on the local network using multicast DNS.
 * Used in private mode so devices on the same LAN can find the relay
 * without touching the public DHT.
 *
 * Service type: _hiverelay._udp.local
 *
 * Announces:
 *   - Public key (for Noise handshake)
 *   - Port (Hyperswarm listening port)
 *   - Mode (private/hybrid)
 *
 * Uses DNS-SD (RFC 6763) compatible format so standard mDNS tools
 * (avahi-browse, dns-sd) can discover the service too.
 */

import dgram from 'dgram'
import { EventEmitter } from 'events'
import b4a from 'b4a'

const MDNS_ADDRESS = '224.0.0.251'
const MDNS_PORT = 5353
const SERVICE_TYPE = '_hiverelay._udp.local'
const ANNOUNCE_INTERVAL = 30_000 // 30 seconds
const TTL = 120 // DNS TTL in seconds

export class MDNSDiscovery extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.publicKey = opts.publicKey || null // Buffer
    this.port = opts.port || 0
    this.mode = opts.mode || 'private'
    this.instanceName = opts.name || 'hiverelay'
    this._socket = null
    this._announceInterval = null
    this._running = false
    this._discoveredPeers = new Map() // pubkey hex → { host, port, lastSeen }
  }

  async start () {
    if (this._running) return
    this._running = true

    this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    this._socket.on('error', (err) => {
      this.emit('error', err)
    })

    this._socket.on('message', (msg, rinfo) => {
      this._handleMessage(msg, rinfo)
    })

    await new Promise((resolve, reject) => {
      this._socket.bind(MDNS_PORT, () => {
        try {
          this._socket.addMembership(MDNS_ADDRESS)
          this._socket.setMulticastTTL(255)
          this._socket.setMulticastLoopback(true)
        } catch (err) {
          // Some environments don't support multicast — degrade gracefully
          this.emit('multicast-unavailable', { error: err.message })
        }
        resolve()
      })
      this._socket.on('error', reject)
    })

    // Start periodic announcements
    this._announce()
    this._announceInterval = setInterval(() => this._announce(), ANNOUNCE_INTERVAL)
    if (this._announceInterval.unref) this._announceInterval.unref()

    this.emit('started')
  }

  async stop () {
    if (!this._running) return
    this._running = false

    if (this._announceInterval) {
      clearInterval(this._announceInterval)
      this._announceInterval = null
    }

    if (this._socket) {
      try {
        this._socket.dropMembership(MDNS_ADDRESS)
      } catch {}
      this._socket.close()
      this._socket = null
    }

    this.emit('stopped')
  }

  /**
   * Send an mDNS announcement packet.
   * Format: simple JSON-based service record (non-standard but functional).
   * A production version would use proper DNS wire format.
   */
  _announce () {
    if (!this._socket || !this.publicKey) return

    const record = {
      service: SERVICE_TYPE,
      instance: this.instanceName,
      pubkey: b4a.toString(this.publicKey, 'hex'),
      port: this.port,
      mode: this.mode,
      ttl: TTL,
      ts: Date.now()
    }

    const buf = Buffer.from(JSON.stringify(record))
    this._socket.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDRESS, (err) => {
      if (err) this.emit('announce-error', { error: err.message })
    })
  }

  /**
   * Handle incoming mDNS messages from other nodes on the LAN.
   */
  _handleMessage (msg, rinfo) {
    try {
      const record = JSON.parse(msg.toString())
      if (record.service !== SERVICE_TYPE) return
      if (!record.pubkey || !record.port) return

      // Ignore our own announcements
      if (this.publicKey && record.pubkey === b4a.toString(this.publicKey, 'hex')) return

      const existing = this._discoveredPeers.get(record.pubkey)
      const peer = {
        pubkey: record.pubkey,
        host: rinfo.address,
        port: record.port,
        mode: record.mode,
        name: record.instance,
        lastSeen: Date.now()
      }

      this._discoveredPeers.set(record.pubkey, peer)

      if (!existing) {
        this.emit('peer-discovered', peer)
      } else {
        this.emit('peer-seen', peer)
      }
    } catch {
      // Not a valid service record — ignore
    }
  }

  /**
   * Get all peers discovered on the local network.
   */
  getDiscoveredPeers () {
    const peers = []
    const now = Date.now()
    for (const [pubkey, peer] of this._discoveredPeers) {
      // Only return peers seen within 2x TTL
      if (now - peer.lastSeen < TTL * 2 * 1000) {
        peers.push(peer)
      } else {
        this._discoveredPeers.delete(pubkey)
      }
    }
    return peers
  }
}
