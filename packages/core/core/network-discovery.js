/**
 * Network Discovery Service
 *
 * Joins the Hyperswarm DHT on the well-known relay discovery topic as a client,
 * discovers all live relay nodes, polls their APIs for stats, and maintains
 * a live registry of the network.
 *
 * No central registry — fully DHT-driven. Any relay that announces on the
 * discovery topic is automatically found and tracked.
 */

import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { EventEmitter } from 'events'
import http from 'http'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { createRequire } from 'module'
import { RELAY_DISCOVERY_TOPIC } from './constants.js'

const POLL_INTERVAL = 30_000 // poll each relay every 30s
const STALE_THRESHOLD = 5 * 60_000 // remove relays not seen for 5 min
const API_TIMEOUT = 8000
const HOLESAIL_CLIENT_MAX = 20
const HOLESAIL_CLIENT_TTL = 5 * 60_000 // destroy clients unused for 5 min
const META_PROTOCOL = 'hiverelay-meta'

export class NetworkDiscovery extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.swarm = opts.swarm || null // can share the relay node's swarm
    this._ownSwarm = false
    this._bootstrap = opts.bootstrap || undefined
    this._relays = new Map() // pubkey hex -> { host, port, apiPort, holesailKey, holesailConnected, lastSeen, data }
    this._connections = new Map() // pubkey hex -> conn
    this._pollInterval = null
    this._cleanupInterval = null
    this._localHolesailKey = null
    this._holesailClients = new Map() // holesailKey -> { client, localPort, lastUsed }
    this._holesailCleanupInterval = null
    this.running = false
  }

  setLocalHolesailKey (key) {
    this._localHolesailKey = key
  }

  async start () {
    if (this.running) return

    // If no swarm provided, create our own as a client
    if (!this.swarm) {
      this.swarm = new Hyperswarm({ bootstrap: this._bootstrap })
      this._ownSwarm = true
    }

    // Join discovery topic as client to find relay nodes
    this.swarm.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })

    this.swarm.on('connection', (conn, info) => {
      this._onConnection(conn, info)
    })

    await this.swarm.flush()

    // Poll known relays for stats
    this._pollInterval = setInterval(() => {
      this._pollAll().catch(() => {})
    }, POLL_INTERVAL)
    if (this._pollInterval.unref) this._pollInterval.unref()

    // Clean up stale relays
    this._cleanupInterval = setInterval(() => {
      this._cleanup()
    }, STALE_THRESHOLD)
    if (this._cleanupInterval.unref) this._cleanupInterval.unref()

    // Clean up idle holesail clients
    this._holesailCleanupInterval = setInterval(() => {
      this._cleanupHolesailClients()
    }, HOLESAIL_CLIENT_TTL)
    if (this._holesailCleanupInterval.unref) this._holesailCleanupInterval.unref()

    this.running = true
    this.emit('started')
  }

  _onConnection (conn, info) {
    const pubkey = info.publicKey
      ? b4a.toString(info.publicKey, 'hex')
      : (conn.remotePublicKey ? b4a.toString(conn.remotePublicKey, 'hex') : null)

    if (!pubkey) return

    // Extract remote address from the raw stream
    const remoteHost = conn.rawStream
      ? conn.rawStream.remoteHost || conn.rawStream.remoteAddress
      : null
    const remotePort = conn.rawStream
      ? conn.rawStream.remotePort
      : null

    // Track this relay
    if (!this._relays.has(pubkey)) {
      this._relays.set(pubkey, {
        publicKey: pubkey,
        host: remoteHost,
        port: remotePort,
        apiPort: null,
        lastSeen: Date.now(),
        data: null,
        online: true
      })
      this.emit('relay-discovered', { publicKey: pubkey, host: remoteHost })
    } else {
      const relay = this._relays.get(pubkey)
      relay.lastSeen = Date.now()
      relay.online = true
      if (remoteHost) relay.host = remoteHost
    }

    this._connections.set(pubkey, conn)

    // Exchange holesail metadata via Protomux channel
    this._exchangeMetadata(conn, pubkey)

    // Try to discover the API port by probing common ports
    if (remoteHost) {
      this._probeApiPort(pubkey, remoteHost).catch(() => {})
    }

    conn.on('close', () => {
      this._connections.delete(pubkey)
    })

    conn.on('error', () => {
      this._connections.delete(pubkey)
    })
  }

  /**
   * Exchange holesail keys (and future metadata) over a Protomux channel
   */
  _exchangeMetadata (conn, pubkey) {
    try {
      const mux = Protomux.from(conn)

      const channel = mux.createChannel({
        protocol: META_PROTOCOL,
        id: null,
        handshake: c.raw,
        onopen: () => {
          // Send our holesail key if we have one
          if (this._localHolesailKey) {
            metaMsg.send(b4a.from(JSON.stringify({ holesailKey: this._localHolesailKey })))
          }
        },
        onclose: () => {}
      })

      const metaMsg = channel.addMessage({
        encoding: c.raw,
        onmessage: (buf) => {
          try {
            const meta = JSON.parse(b4a.toString(buf))
            if (meta.holesailKey) {
              const relay = this._relays.get(pubkey)
              if (relay) {
                relay.holesailKey = meta.holesailKey
                this.emit('relay-holesail-key', { publicKey: pubkey, holesailKey: meta.holesailKey })
              }
            }
          } catch {}
        }
      })

      channel.open(b4a.alloc(0))
    } catch {}
  }

  /**
   * Probe common API ports on a discovered relay to find its HTTP API
   */
  async _probeApiPort (pubkey, host) {
    const relay = this._relays.get(pubkey)
    if (!relay) return

    const ports = [9100, 9101, 9102, 9103, 9104, 9105]

    for (const port of ports) {
      try {
        const data = await this._fetchApi(host, port)
        if (data && data.publicKey) {
          if (data.publicKey === pubkey) {
            // Exact match — this is the relay we're probing
            relay.apiPort = port
            relay.data = data
            relay.lastSeen = Date.now()
            this.emit('relay-api-found', { publicKey: pubkey, host, port })
          } else if (!this._relays.has(data.publicKey) || !this._relays.get(data.publicKey).apiPort) {
            // Different relay on the same host (multi-instance) — register it too
            const otherPubkey = data.publicKey
            if (!this._relays.has(otherPubkey)) {
              this._relays.set(otherPubkey, {
                publicKey: otherPubkey,
                host,
                port: null,
                apiPort: port,
                lastSeen: Date.now(),
                data,
                online: true
              })
              this.emit('relay-discovered', { publicKey: otherPubkey, host })
              this.emit('relay-api-found', { publicKey: otherPubkey, host, port })
            } else {
              const other = this._relays.get(otherPubkey)
              other.apiPort = port
              other.data = data
              other.host = host
              other.lastSeen = Date.now()
              other.online = true
            }
          }
          // Keep probing other ports on this host to find all instances
          continue
        }
      } catch {
        continue
      }
    }

    // If direct probe failed, try holesail tunnel as fallback
    if (!relay.apiPort && relay.holesailKey) {
      try {
        const data = await this._fetchViaHolesail(relay.holesailKey)
        if (data && data.publicKey) {
          relay.data = data
          relay.apiPort = 'holesail'
          relay.holesailConnected = true
          relay.lastSeen = Date.now()
          // Capture holesail key from overview if not already set
          if (data.holesailKey && !relay.holesailKey) {
            relay.holesailKey = data.holesailKey
          }
          this.emit('relay-api-found', { publicKey: pubkey, holesailKey: relay.holesailKey })
        }
      } catch {}
    }
  }

  /**
   * Fetch /api/overview from a relay's HTTP API
   */
  _fetchApi (host, port) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://${host}:${port}/api/overview`,
        { timeout: API_TIMEOUT },
        (res) => {
          let data = ''
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error('Invalid JSON'))
            }
          })
        }
      )

      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Timeout'))
      })

      req.on('error', reject)
    })
  }

  /**
   * Fetch /api/overview via holesail tunnel
   * Creates a local proxy client if one doesn't exist for this key
   */
  async _fetchViaHolesail (holesailKey) {
    let entry = this._holesailClients.get(holesailKey)

    if (!entry || !entry.client || entry.client.state === 'destroyed') {
      // Evict oldest client if at capacity
      if (this._holesailClients.size >= HOLESAIL_CLIENT_MAX) {
        let oldestKey = null
        let oldestTime = Infinity
        for (const [k, v] of this._holesailClients) {
          if (v.lastUsed < oldestTime) {
            oldestTime = v.lastUsed
            oldestKey = k
          }
        }
        if (oldestKey) {
          const old = this._holesailClients.get(oldestKey)
          try { await old.client.destroy() } catch {}
          this._holesailClients.delete(oldestKey)
        }
      }

      const require = createRequire(import.meta.url)
      const HolesailClient = require('holesail-client')
      const localPort = 30000 + Math.floor(Math.random() * 30000)
      const client = new HolesailClient({ key: holesailKey })

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('holesail connect timeout')), 15000)
        client.connect({ port: localPort, host: '127.0.0.1' }, () => {
          clearTimeout(timer)
          resolve()
        })
      })

      entry = { client, localPort, lastUsed: Date.now() }
      this._holesailClients.set(holesailKey, entry)
    }

    entry.lastUsed = Date.now()
    return this._fetchApi('127.0.0.1', entry.localPort)
  }

  /**
   * Destroy holesail clients that haven't been used recently
   */
  _cleanupHolesailClients () {
    const now = Date.now()
    for (const [key, entry] of this._holesailClients) {
      if (now - entry.lastUsed > HOLESAIL_CLIENT_TTL) {
        try { entry.client.destroy() } catch {}
        this._holesailClients.delete(key)
      }
    }
  }

  /**
   * Poll all known relays for fresh stats
   */
  async _pollAll () {
    const polls = []

    for (const [pubkey, relay] of this._relays) {
      let pollPromise

      if (relay.holesailConnected && relay.holesailKey) {
        // Use holesail tunnel for relays without direct access
        pollPromise = this._fetchViaHolesail(relay.holesailKey)
      } else if (relay.host && relay.apiPort && relay.apiPort !== 'holesail') {
        pollPromise = this._fetchApi(relay.host, relay.apiPort)
      } else if (relay.holesailKey) {
        // No direct apiPort yet, try holesail
        pollPromise = this._fetchViaHolesail(relay.holesailKey)
      } else {
        continue
      }

      const poll = pollPromise
        .then((data) => {
          relay.data = data
          relay.lastSeen = Date.now()
          relay.online = true
          // Pick up holesail key from overview response
          if (data.holesailKey && !relay.holesailKey) {
            relay.holesailKey = data.holesailKey
          }
        })
        .catch(() => {
          const age = Date.now() - relay.lastSeen
          if (age > STALE_THRESHOLD) {
            relay.online = false
          }
        })

      polls.push(poll)
    }

    await Promise.allSettled(polls)
    this.emit('poll-complete', { relayCount: this._relays.size })
  }

  /**
   * Remove relays that haven't been seen in a long time
   */
  _cleanup () {
    const now = Date.now()
    for (const [pubkey, relay] of this._relays) {
      if (now - relay.lastSeen > STALE_THRESHOLD * 3) {
        this._relays.delete(pubkey)
        this.emit('relay-removed', { publicKey: pubkey })
      }
    }
  }

  /**
   * Get the full network state — used by /api/network endpoint
   */
  getNetworkState () {
    const relays = []
    let totalConnections = 0
    let totalStorage = 0
    let totalStorageMax = 0
    let onlineCount = 0

    for (const [pubkey, relay] of this._relays) {
      const d = relay.data || {}
      const entry = {
        publicKey: pubkey,
        name: 'Relay ' + pubkey.slice(0, 8),
        host: relay.host,
        apiPort: relay.apiPort,
        region: d.region || null,
        online: relay.online,
        lastSeen: relay.lastSeen,
        uptime: d.uptime || null,
        connections: d.connections || 0,
        seededApps: d.seededApps || 0,
        storage: d.storage || null,
        relay: d.relay || null,
        seeder: d.seeder || null,
        memory: d.memory || null,
        tor: d.tor || null,
        holesailKey: relay.holesailKey || null,
        holesailConnected: relay.holesailConnected || false,
        errors: d.errors || 0
      }

      if (relay.online) onlineCount++
      totalConnections += entry.connections
      if (d.storage) {
        totalStorage += d.storage.used || 0
        totalStorageMax += d.storage.max || 0
      }

      relays.push(entry)
    }

    // Sort: online first, then by uptime
    relays.sort((a, b) => {
      if (a.online && !b.online) return -1
      if (!a.online && b.online) return 1
      const aUp = a.uptime ? a.uptime.ms : 0
      const bUp = b.uptime ? b.uptime.ms : 0
      return bUp - aUp
    })

    return {
      timestamp: Date.now(),
      summary: {
        totalRelays: relays.length,
        onlineRelays: onlineCount,
        totalConnections,
        totalStorage,
        totalStorageMax
      },
      relays
    }
  }

  async stop () {
    if (!this.running) return

    if (this._pollInterval) {
      clearInterval(this._pollInterval)
      this._pollInterval = null
    }
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval)
      this._cleanupInterval = null
    }
    if (this._holesailCleanupInterval) {
      clearInterval(this._holesailCleanupInterval)
      this._holesailCleanupInterval = null
    }

    // Destroy holesail clients
    for (const entry of this._holesailClients.values()) {
      try { entry.client.destroy() } catch {}
    }
    this._holesailClients.clear()

    // Close connections we're tracking
    for (const conn of this._connections.values()) {
      try { conn.destroy() } catch {}
    }
    this._connections.clear()

    if (this._ownSwarm && this.swarm) {
      try { await this.swarm.destroy() } catch {}
      this.swarm = null
    }

    this.running = false
    this.emit('stopped')
  }
}
