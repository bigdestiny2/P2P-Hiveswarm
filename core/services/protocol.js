/**
 * Service Protocol
 *
 * Protomux-based RPC protocol for service communication between peers.
 * Each connection gets a service channel where peers can:
 *   - Exchange service catalogs (what services each relay offers)
 *   - Make RPC calls to remote services
 *   - Receive responses and errors
 *
 * Message types:
 *   0: CATALOG   - Advertise available services
 *   1: REQUEST   - RPC call: { id, service, method, params }
 *   2: RESPONSE  - RPC reply: { id, result }
 *   3: ERROR     - RPC error: { id, error }
 *
 * Wire format: JSON over Protomux binary channel.
 * Future: switch to compact-encoding for performance.
 */

import b4a from 'b4a'
import Protomux from 'protomux'
import { EventEmitter } from 'events'

const MSG_CATALOG = 0
const MSG_REQUEST = 1
const MSG_RESPONSE = 2
const MSG_ERROR = 3

const RESTRICTED_METHODS = new Set([
  'identity.sign',
  'identity.verify',
  'ai.register-model',
  'ai.remove-model'
])

const MSG_SUBSCRIBE = 4
const MSG_UNSUBSCRIBE = 5
const MSG_EVENT = 6
const MSG_APP_CATALOG = 7

export class ServiceProtocol extends EventEmitter {
  constructor (registry, opts = {}) {
    super()
    this.registry = registry
    this.router = null // Set by RelayNode after Router creation
    this.channels = new Map() // remotePubkey -> channel
    this._pendingRequests = new Map() // requestId -> { resolve, reject, timer }
    this._peerSubscriptions = new Map() // remotePubkey -> [subId]
    this._nextId = 1
    this.requestTimeout = 30_000

    // Role-based authorization
    this._peerRoles = new Map() // pubkey hex -> role string
    this._defaultPeerRole = opts.defaultPeerRole || 'anonymous'

    // Per-peer rate limiting
    this._rateLimitMax = opts.rateLimitMax || 100 // requests per window
    this._rateLimitWindow = opts.rateLimitWindow || 60_000 // 1 minute
    this._peerRateState = new Map() // pubkey -> { tokens, lastRefill }
  }

  /**
   * Assign a role to a peer by pubkey.
   */
  setPeerRole (pubkey, role) {
    this._peerRoles.set(pubkey, role)
  }

  /**
   * Check and consume a rate-limit token for a peer.
   * Returns true if the request is allowed, false if rate-limited.
   */
  _checkRateLimit (pubkey) {
    const now = Date.now()
    let state = this._peerRateState.get(pubkey)

    if (!state) {
      state = { tokens: this._rateLimitMax, lastRefill: now }
      this._peerRateState.set(pubkey, state)
    }

    // Refill tokens based on elapsed time
    const elapsed = now - state.lastRefill
    if (elapsed > 0) {
      const refill = Math.floor((elapsed / this._rateLimitWindow) * this._rateLimitMax)
      if (refill > 0) {
        state.tokens = Math.min(this._rateLimitMax, state.tokens + refill)
        state.lastRefill = now
      }
    }

    if (state.tokens <= 0) return false
    state.tokens--
    return true
  }

  /**
   * Set up the service protocol on a Protomux instance.
   */
  attach (mux, remotePubkey) {
    mux = Protomux.from(mux)
    const channel = mux.createChannel({
      protocol: 'hiverelay-services',
      id: b4a.from('services-v1'),
      onopen: () => this._onOpen(remotePubkey, channel),
      onclose: () => this._onClose(remotePubkey)
    })

    if (!channel) return null

    const msgHandler = channel.addMessage({
      encoding: {
        preencode (state, msg) {
          const json = JSON.stringify(msg)
          state.end += 4 + b4a.byteLength(json)
        },
        encode (state, msg) {
          const json = JSON.stringify(msg)
          const buf = b4a.from(json)
          state.buffer.writeUInt32BE(buf.length, state.start)
          buf.copy(state.buffer, state.start + 4)
          state.start += 4 + buf.length
        },
        decode (state) {
          const len = state.buffer.readUInt32BE(state.start)
          if (len > 1048576) { // 1 MB max message size
            state.start += 4 + len
            return { type: -1, error: 'message too large' }
          }
          const json = state.buffer.subarray(state.start + 4, state.start + 4 + len).toString()
          state.start += 4 + len
          try {
            return JSON.parse(json)
          } catch (_) {
            return { type: -1, error: 'malformed JSON' }
          }
        }
      },
      onmessage: (msg) => this._onMessage(remotePubkey, msg)
    })

    this.channels.set(remotePubkey, { channel, msgHandler })
    channel.open()

    return channel
  }

  /**
   * Detach and close a channel.
   */
  detach (remotePubkey) {
    const entry = this.channels.get(remotePubkey)
    if (entry) {
      entry.channel.close()
      this.channels.delete(remotePubkey)
    }
  }

  /**
   * Call a remote service method.
   */
  async request (remotePubkey, service, method, params = {}) {
    const entry = this.channels.get(remotePubkey)
    if (!entry) throw new Error('NO_CHANNEL: not connected to ' + remotePubkey)

    const id = this._nextId++

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id)
        reject(new Error('REQUEST_TIMEOUT'))
      }, this.requestTimeout)

      this._pendingRequests.set(id, { resolve, reject, timer, remotePubkey })

      entry.msgHandler.send({
        type: MSG_REQUEST,
        id,
        service,
        method,
        params
      })
    })
  }

  /**
   * Broadcast our service catalog to a peer.
   */
  sendCatalog (remotePubkey) {
    const entry = this.channels.get(remotePubkey)
    if (!entry) return

    entry.msgHandler.send({
      type: MSG_CATALOG,
      services: this.registry.catalog()
    })
  }

  /**
   * Send the list of seeded apps to a peer.
   * Called on connect so clients know what apps are available.
   */
  sendAppCatalog (remotePubkey) {
    const entry = this.channels.get(remotePubkey)
    if (!entry) return
    entry.msgHandler.send(this._buildCatalogMessage())
  }

  /**
   * Broadcast app catalog update to all connected peers.
   * Called when apps are seeded or unseeded.
   */
  broadcastAppCatalog () {
    const msg = this._buildCatalogMessage()

    for (const [, entry] of this.channels) {
      try { entry.msgHandler.send(msg) } catch {}
    }
  }

  _buildCatalogMessage () {
    if (this._getCatalogEnvelope) {
      const envelope = this._getCatalogEnvelope() || {}
      return {
        type: MSG_APP_CATALOG,
        apps: Array.isArray(envelope.apps) ? envelope.apps : [],
        relayPubkey: envelope.relayPubkey || null,
        catalogTimestamp: envelope.catalogTimestamp || null,
        signature: envelope.signature || null
      }
    }

    const apps = this._getSeededApps ? this._getSeededApps() : []
    return { type: MSG_APP_CATALOG, apps: Array.isArray(apps) ? apps : [] }
  }

  _onOpen (remotePubkey, channel) {
    this.emit('channel-open', { remotePubkey })
    // Send our service catalog and app catalog on connect
    this.sendCatalog(remotePubkey)
    this.sendAppCatalog(remotePubkey)
  }

  _onClose (remotePubkey) {
    this.channels.delete(remotePubkey)
    // Clean up pub/sub subscriptions for this peer
    const subs = this._peerSubscriptions.get(remotePubkey)
    if (subs && this.router) {
      for (const entry of subs) this.router.pubsub.unsubscribe(entry.subId)
    }
    this._peerSubscriptions.delete(remotePubkey)

    // Clean up rate limiter state for this peer
    this._peerRateState.delete(remotePubkey)

    // Reject any pending requests for this peer
    for (const [id, pending] of this._pendingRequests) {
      if (pending.remotePubkey === remotePubkey) {
        clearTimeout(pending.timer)
        this._pendingRequests.delete(id)
        pending.reject(new Error('PEER_DISCONNECTED'))
      }
    }

    this.emit('channel-close', { remotePubkey })
  }

  async _onMessage (remotePubkey, msg) {
    switch (msg.type) {
      case MSG_CATALOG:
        this.registry.addRemoteServices(remotePubkey, msg.services)
        this.emit('catalog-received', { remotePubkey, services: msg.services })
        break

      case MSG_REQUEST:
        await this._handleRequest(remotePubkey, msg)
        break

      case MSG_RESPONSE: {
        const pending = this._pendingRequests.get(msg.id)
        if (pending) {
          clearTimeout(pending.timer)
          this._pendingRequests.delete(msg.id)
          pending.resolve(msg.result)
        }
        break
      }

      case MSG_ERROR: {
        const pending2 = this._pendingRequests.get(msg.id)
        if (pending2) {
          clearTimeout(pending2.timer)
          this._pendingRequests.delete(msg.id)
          pending2.reject(new Error(msg.error))
        }
        break
      }

      case MSG_SUBSCRIBE:
        this._handleSubscribe(remotePubkey, msg)
        break

      case MSG_UNSUBSCRIBE:
        this._handleUnsubscribe(remotePubkey, msg)
        break

      case MSG_EVENT:
        this.emit('event', { remotePubkey, topic: msg.topic, data: msg.data })
        break

      case MSG_APP_CATALOG:
        this.emit('app-catalog', {
          remotePubkey,
          apps: Array.isArray(msg.apps) ? msg.apps : [],
          relayPubkey: msg.relayPubkey || null,
          catalogTimestamp: msg.catalogTimestamp || null,
          signature: msg.signature || null
        })
        break
    }
  }

  async _handleRequest (remotePubkey, msg) {
    const entry = this.channels.get(remotePubkey)
    if (!entry) return

    // Per-peer rate limiting
    if (!this._checkRateLimit(remotePubkey)) {
      entry.msgHandler.send({
        type: MSG_ERROR,
        id: msg.id,
        error: 'RATE_LIMITED'
      })
      return
    }

    const qualifiedMethod = msg.service + '.' + msg.method
    if (RESTRICTED_METHODS.has(qualifiedMethod)) {
      entry.msgHandler.send({
        type: MSG_ERROR,
        id: msg.id,
        error: 'ACCESS_DENIED: method requires local access'
      })
      return
    }

    // Role-based authorization
    const role = this._peerRoles.get(remotePubkey) || this._defaultPeerRole
    const authenticated = this._peerRoles.has(remotePubkey)

    try {
      let result
      if (this.router) {
        const route = `${msg.service}.${msg.method}`
        result = await this.router.dispatch(route, msg.params, {
          transport: 'p2p',
          remotePubkey,
          caller: 'remote',
          role,
          authenticated
        })
      } else {
        result = await this.registry.handleRequest(
          msg.service,
          msg.method,
          msg.params,
          { remotePubkey, role, authenticated }
        )
      }
      entry.msgHandler.send({
        type: MSG_RESPONSE,
        id: msg.id,
        result
      })
    } catch (err) {
      entry.msgHandler.send({
        type: MSG_ERROR,
        id: msg.id,
        error: err.message
      })
    }
  }

  /**
   * Handle P2P pub/sub subscription request from a peer.
   */
  _handleSubscribe (remotePubkey, msg) {
    if (!this.router || !msg.topics || !Array.isArray(msg.topics)) return
    const entry = this.channels.get(remotePubkey)
    if (!entry) return

    const subs = this._peerSubscriptions.get(remotePubkey) || []

    for (const topic of msg.topics) {
      if (typeof topic !== 'string' || topic.length > 256) continue
      const subId = this.router.pubsub.subscribe(topic, (t, data) => {
        if (entry.channel.opened) {
          entry.msgHandler.send({ type: MSG_EVENT, topic: t, data })
        }
      }, { remotePubkey, ttl: 60 * 60 * 1000 })
      subs.push({ subId, topic })
    }

    this._peerSubscriptions.set(remotePubkey, subs)
  }

  /**
   * Handle P2P pub/sub unsubscription request from a peer.
   */
  _handleUnsubscribe (remotePubkey, msg) {
    if (!this.router || !msg.topics) return
    const subs = this._peerSubscriptions.get(remotePubkey) || []
    const topicsToRemove = new Set(msg.topics)

    // Only unsubscribe from requested topics, retain the rest
    const remaining = []
    for (const entry of subs) {
      if (topicsToRemove.has(entry.topic)) {
        this.router.pubsub.unsubscribe(entry.subId)
      } else {
        remaining.push(entry)
      }
    }

    if (remaining.length > 0) {
      this._peerSubscriptions.set(remotePubkey, remaining)
    } else {
      this._peerSubscriptions.delete(remotePubkey)
    }
  }

  /**
   * Cleanup all channels and pending requests.
   */
  destroy () {
    for (const [, pending] of this._pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('PROTOCOL_DESTROYED'))
    }
    this._pendingRequests.clear()

    for (const [pubkey] of this.channels) {
      this.detach(pubkey)
    }
  }
}
