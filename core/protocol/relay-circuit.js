/**
 * Circuit Relay Protocol
 *
 * Provides NAT traversal fallback when direct hole-punching fails.
 * The relay forwards opaque, E2E-encrypted bytes between two peers.
 *
 * Flow:
 * 1. Peer A (behind NAT) sends RELAY_RESERVE to Relay R
 * 2. R responds with RELAY_RESERVE_OK (reservation granted)
 * 3. Peer B sends RELAY_CONNECT to R, requesting connection to A
 * 4. R bridges the two streams
 * 5. Optionally, A and B attempt direct connection upgrade (DCUtR)
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { EventEmitter } from 'events'
import { ERR, relayReserveEncoding } from './messages.js'

const PROTOCOL_NAME = 'hiverelay-circuit'
const DEFAULT_RESERVATION_TTL = 60 * 60 * 1000 // 1 hour
const DEFAULT_MAX_CIRCUIT_BYTES = 64 * 1024 * 1024 // 64 MB
const DEFAULT_MAX_CIRCUITS_PER_PEER = 5

export class CircuitRelay extends EventEmitter {
  constructor (swarm, relay, opts = {}) {
    super()
    this.swarm = swarm
    this.relay = relay // The Relay instance from relay.js
    this.reservationTTL = opts.reservationTTL || DEFAULT_RESERVATION_TTL
    this.maxCircuitBytes = opts.maxCircuitBytes || DEFAULT_MAX_CIRCUIT_BYTES
    this.maxCircuitsPerPeer = opts.maxCircuitsPerPeer || DEFAULT_MAX_CIRCUITS_PER_PEER

    // Reservations: peer pubkey hex -> { channel, expiresAt, circuitCount }
    this.reservations = new Map()
    // Pending connect requests: target pubkey hex -> [{ source channel, source pubkey, addedAt }]
    this.pendingConnects = new Map()
    // Per-peer reservation rate limit: max 5 reserves per minute
    this._reserveAttempts = new Map() // peer hex -> [timestamps]
    this._maxReservesPerMin = opts.maxReservesPerMin || 5
    this._maxPendingConnects = opts.maxPendingConnects || 100

    this._cleanupInterval = setInterval(() => this._cleanupExpired(), 60_000)
  }

  /**
   * Attach circuit relay protocol to a connection
   */
  attach (conn) {
    const mux = Protomux.from(conn)

    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      id: null,
      onopen: () => this.emit('channel-open', channel),
      onclose: () => this._onChannelClose(channel)
    })

    const reserveMsg = channel.addMessage({
      encoding: relayReserveEncoding,
      onmessage: (msg) => this._onReserve(channel, msg)
    })

    const connectMsg = channel.addMessage({
      encoding: {
        preencode (state, msg) {
          c.fixed32.preencode(state, msg.targetPubkey)
          c.fixed32.preencode(state, msg.sourcePubkey)
        },
        encode (state, msg) {
          c.fixed32.encode(state, msg.targetPubkey)
          c.fixed32.encode(state, msg.sourcePubkey)
        },
        decode (state) {
          return {
            targetPubkey: c.fixed32.decode(state),
            sourcePubkey: c.fixed32.decode(state)
          }
        }
      },
      onmessage: (msg) => this._onConnect(channel, msg)
    })

    const statusMsg = channel.addMessage({
      encoding: {
        preencode (state, msg) {
          c.uint.preencode(state, msg.code)
          c.string.preencode(state, msg.message)
        },
        encode (state, msg) {
          c.uint.encode(state, msg.code)
          c.string.encode(state, msg.message)
        },
        decode (state) {
          return {
            code: c.uint.decode(state),
            message: c.string.decode(state)
          }
        }
      },
      onmessage: (msg) => this.emit('status', msg)
    })

    channel._hiverelay = { reserveMsg, connectMsg, statusMsg }
    channel.open()

    return channel
  }

  _onReserve (channel, msg) {
    const peerHex = b4a.toString(msg.peerPubkey, 'hex')

    // Per-peer reserve rate limiting
    const now = Date.now()
    const attempts = this._reserveAttempts.get(peerHex) || []
    const recentAttempts = attempts.filter(t => now - t < 60_000)
    if (recentAttempts.length >= this._maxReservesPerMin) {
      this._sendStatus(channel, ERR.CAPACITY_FULL, 'Reserve rate limited')
      return
    }
    recentAttempts.push(now)
    this._reserveAttempts.set(peerHex, recentAttempts)

    // Check capacity
    if (this.relay && this.relay.circuits.size >= this.relay.maxConnections) {
      this._sendStatus(channel, ERR.CAPACITY_FULL, 'Relay at capacity')
      return
    }

    // Grant reservation
    this.reservations.set(peerHex, {
      channel,
      peerPubkey: msg.peerPubkey,
      expiresAt: Date.now() + this.reservationTTL,
      circuitCount: 0,
      maxDurationMs: msg.maxDurationMs || this.reservationTTL,
      maxBytes: msg.maxBytes || this.maxCircuitBytes
    })

    this._sendStatus(channel, ERR.NONE, 'Reservation granted')

    this.emit('reservation-granted', {
      peer: peerHex,
      ttl: this.reservationTTL
    })

    // Check for pending connect requests for this peer
    const pending = this.pendingConnects.get(peerHex)
    if (pending) {
      for (const req of pending) {
        this._bridgeCircuit(req.sourceChannel, channel, req.sourcePubkey, msg.peerPubkey)
      }
      this.pendingConnects.delete(peerHex)
    }
  }

  _onConnect (channel, msg) {
    const targetHex = b4a.toString(msg.targetPubkey, 'hex')
    const reservation = this.reservations.get(targetHex)

    if (!reservation || reservation.expiresAt < Date.now()) {
      this._sendStatus(channel, ERR.NOT_FOUND, 'No reservation for target peer')
      return
    }

    if (reservation.circuitCount >= this.maxCircuitsPerPeer) {
      this._sendStatus(channel, ERR.CAPACITY_FULL, 'Max circuits per peer reached')
      return
    }

    this._bridgeCircuit(channel, reservation.channel, msg.sourcePubkey, msg.targetPubkey)
    reservation.circuitCount++
  }

  _bridgeCircuit (sourceChannel, destChannel, sourcePubkey, destPubkey) {
    const circuitId = b4a.toString(b4a.concat([sourcePubkey, destPubkey]).slice(0, 16), 'hex')
    const sourcePeerKey = b4a.toString(sourcePubkey, 'hex')

    if (this.relay) {
      try {
        // Use the Relay class to manage the circuit lifecycle
        this.relay.createCircuit(circuitId, sourceChannel.stream, destChannel.stream, sourcePeerKey)
      } catch (err) {
        if (err.message === 'PEER_AT_CAPACITY') {
          this._sendStatus(sourceChannel, ERR.CAPACITY_FULL, 'Max circuits per peer reached')
          return
        }
        throw err
      }
    }

    this.emit('circuit-bridged', {
      circuitId,
      source: sourcePeerKey.slice(0, 8),
      dest: b4a.toString(destPubkey, 'hex').slice(0, 8)
    })
  }

  _sendStatus (channel, code, message) {
    if (channel.opened && channel._hiverelay) {
      channel._hiverelay.statusMsg.send({ code, message })
    }
  }

  _onChannelClose (channel) {
    // Remove reservations held by this channel
    for (const [key, res] of this.reservations) {
      if (res.channel === channel) {
        this.reservations.delete(key)
      }
    }
    this.emit('channel-close', channel)
  }

  _cleanupExpired () {
    const now = Date.now()
    for (const [key, res] of this.reservations) {
      if (res.expiresAt < now) {
        this.reservations.delete(key)
        this.emit('reservation-expired', { peer: key })
      }
    }
    // Evict stale pending connects (older than reservation TTL)
    for (const [key, reqs] of this.pendingConnects) {
      const active = reqs.filter(r => !r.addedAt || now - r.addedAt < this.reservationTTL)
      if (active.length === 0) this.pendingConnects.delete(key)
      else this.pendingConnects.set(key, active)
    }
    // Prune stale rate limit entries
    for (const [key, attempts] of this._reserveAttempts) {
      const recent = attempts.filter(t => now - t < 60_000)
      if (recent.length === 0) this._reserveAttempts.delete(key)
      else this._reserveAttempts.set(key, recent)
    }
  }

  getStats () {
    return {
      activeReservations: this.reservations.size,
      pendingConnects: this.pendingConnects.size
    }
  }

  destroy () {
    clearInterval(this._cleanupInterval)
    this.reservations.clear()
    this.pendingConnects.clear()
    this._reserveAttempts.clear()
  }
}
