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
 *   - Public key (in TXT record)
 *   - Port (SRV record)
 *   - Mode (in TXT record)
 *
 * Uses proper DNS-SD (RFC 6763) wire format via multicast-dns library.
 * Compatible with avahi-browse, dns-sd, and other mDNS tools.
 */

import { EventEmitter } from 'events'
import { hostname, networkInterfaces } from 'os'
import b4a from 'b4a'

const SERVICE_TYPE = '_hiverelay._udp.local'
const ANNOUNCE_INTERVAL = 30_000 // 30 seconds
const PEER_TTL_MS = 120_000 // 2 minutes

export class MDNSDiscovery extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.publicKey = opts.publicKey || null // Buffer
    this.port = opts.port || 0
    this.mode = opts.mode || 'private'
    this.instanceName = opts.name || 'hiverelay'
    this._mdns = null
    this._announceInterval = null
    this._running = false
    this._discoveredPeers = new Map() // pubkey hex → { host, port, lastSeen }
  }

  async start () {
    if (this._running) return
    this._running = true

    const mDNS = (await import('multicast-dns')).default
    this._mdns = mDNS({
      multicast: true,
      reuseAddr: true,
      loopback: true
    })

    this._mdns.on('response', (response, rinfo) => {
      this._handleResponse(response, rinfo)
    })

    this._mdns.on('query', (query, rinfo) => {
      // Respond to queries for our service type
      this._handleQuery(query, rinfo)
    })

    this._mdns.on('error', (err) => {
      this.emit('error', err)
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

    if (this._mdns) {
      this._mdns.destroy()
      this._mdns = null
    }

    this.emit('stopped')
  }

  /**
   * Send an mDNS announcement with proper DNS-SD records.
   */
  _announce () {
    if (!this._mdns || !this.publicKey) return

    const host = hostname() + '.local'
    const instanceFull = `${this.instanceName}.${SERVICE_TYPE}`
    const pubkeyHex = b4a.toString(this.publicKey, 'hex')
    const localAddresses = this.getLocalAddresses()

    const answers = [
      // PTR: _hiverelay._udp.local → instance._hiverelay._udp.local
      {
        name: SERVICE_TYPE,
        type: 'PTR',
        ttl: 120,
        data: instanceFull
      },
      // SRV: instance → host:port
      {
        name: instanceFull,
        type: 'SRV',
        ttl: 120,
        data: {
          port: this.port,
          weight: 0,
          priority: 0,
          target: host
        }
      },
      // TXT: metadata (pubkey, mode, addresses)
      {
        name: instanceFull,
        type: 'TXT',
        ttl: 120,
        data: [
          `pk=${pubkeyHex}`,
          `mode=${this.mode}`,
          `v=1`,
          `addrs=${localAddresses.map(a => a.address).join(',')}`
        ]
      }
    ]

    // A records for each local IPv4 address — ensures wifi clients can
    // resolve the relay without depending on hostname resolution
    for (const addr of localAddresses) {
      if (addr.family === 'IPv4') {
        answers.push({
          name: host,
          type: 'A',
          ttl: 120,
          data: addr.address
        })
      }
    }

    this._mdns.respond({ answers }, (err) => {
      if (err) this.emit('announce-error', { error: err.message })
    })
  }

  /**
   * Respond to DNS-SD queries for our service type.
   */
  _handleQuery (query, rinfo) {
    const isForUs = query.questions.some(q =>
      q.name === SERVICE_TYPE && (q.type === 'PTR' || q.type === 'ANY')
    )
    if (isForUs) {
      this._announce()
    }
  }

  /**
   * Handle incoming mDNS responses — extract peer info.
   */
  _handleResponse (response, rinfo) {
    // Look for our service type in answers + additionals
    const allRecords = [...(response.answers || []), ...(response.additionals || [])]

    // Find SRV and TXT records for hiverelay instances
    let srvRecord = null
    let txtRecord = null

    for (const record of allRecords) {
      if (record.type === 'SRV' && record.name.endsWith(SERVICE_TYPE)) {
        srvRecord = record
      }
      if (record.type === 'TXT' && record.name.endsWith(SERVICE_TYPE)) {
        txtRecord = record
      }
    }

    if (!srvRecord || !txtRecord) return

    // Parse TXT data
    const txtMap = {}
    const txtEntries = Array.isArray(txtRecord.data) ? txtRecord.data : [txtRecord.data]
    for (const entry of txtEntries) {
      const str = Buffer.isBuffer(entry) ? entry.toString() : String(entry)
      const eqIdx = str.indexOf('=')
      if (eqIdx > 0) {
        txtMap[str.substring(0, eqIdx)] = str.substring(eqIdx + 1)
      }
    }

    const pubkey = txtMap.pk
    if (!pubkey) return

    // Ignore our own announcements
    if (this.publicKey && pubkey === b4a.toString(this.publicKey, 'hex')) return

    // Parse advertised addresses from TXT record (wifi + LAN IPs)
    const advertisedAddrs = txtMap.addrs ? txtMap.addrs.split(',').filter(Boolean) : []

    const peer = {
      pubkey,
      host: rinfo.address,
      port: srvRecord.data.port,
      addresses: advertisedAddrs, // All IPs the relay is reachable on
      mode: txtMap.mode || 'unknown',
      name: srvRecord.name.replace('.' + SERVICE_TYPE, ''),
      lastSeen: Date.now()
    }

    const existing = this._discoveredPeers.get(pubkey)
    this._discoveredPeers.set(pubkey, peer)

    if (!existing) {
      this.emit('peer-discovered', peer)
    } else {
      this.emit('peer-seen', peer)
    }
  }

  /**
   * Get all non-internal, non-loopback local network addresses.
   * Returns both wifi and wired LAN interfaces.
   */
  getLocalAddresses () {
    const interfaces = networkInterfaces()
    const addresses = []
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.internal) continue
        addresses.push({
          interface: name,
          address: addr.address,
          family: addr.family === 'IPv4' || addr.family === 4 ? 'IPv4' : 'IPv6',
          netmask: addr.netmask,
          mac: addr.mac
        })
      }
    }
    return addresses
  }

  /**
   * Get all peers discovered on the local network.
   */
  getDiscoveredPeers () {
    const peers = []
    const now = Date.now()
    for (const [pubkey, peer] of this._discoveredPeers) {
      if (now - peer.lastSeen < PEER_TTL_MS) {
        peers.push(peer)
      } else {
        this._discoveredPeers.delete(pubkey)
      }
    }
    return peers
  }
}
