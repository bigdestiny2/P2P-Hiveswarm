/**
 * Seed Request Protocol
 *
 * Handles publishing and accepting seed requests over protomux channels.
 * Publishers request relays to seed their Hypercores/Hyperdrives.
 * Relays discover and accept requests matching their capacity.
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import { EventEmitter } from 'events'
import {
  seedRequestEncoding,
  seedAcceptEncoding
} from './messages.js'
import { TokenBucketRateLimiter } from './rate-limiter.js'

const PROTOCOL_NAME = 'hiverelay-seed'
const PROTOCOL_VERSION = { major: 1, minor: 0 }

// Rate limit: 100 requests per minute, burst of 20
const RATE_LIMIT_TOKENS_PER_MIN = 100
const RATE_LIMIT_BURST = 20

export class SeedProtocol extends EventEmitter {
  constructor (swarm, opts = {}) {
    super()
    this.swarm = swarm
    this.keyPair = opts.keyPair || null
    this.pendingRequests = new Map() // appKey hex -> seed request
    this.acceptedSeeds = new Map() // appKey hex -> { relay pubkey, accepted at }
    this.channels = new Set()
    this._maxPendingRequests = opts.maxPendingRequests || 1000
    this._pendingTTL = opts.pendingTTL || 30 * 60 * 1000 // 30 min default
    this._pendingCleanup = setInterval(() => this._evictStalePending(), 60_000)
    this.rateLimiter = new TokenBucketRateLimiter({
      tokensPerMinute: opts.rateLimitTokens || RATE_LIMIT_TOKENS_PER_MIN,
      burstSize: opts.rateLimitBurst || RATE_LIMIT_BURST
    })
  }

  /**
   * Attach the seed protocol to a Hyperswarm connection
   */
  attach (conn) {
    const mux = Protomux.from(conn)

    const channel = mux.createChannel({
      protocol: PROTOCOL_NAME,
      id: null,
      handshake: c.raw,
      onopen: () => this._onOpen(channel),
      onclose: () => this._onClose(channel)
    })

    const seedRequestMsg = channel.addMessage({
      encoding: seedRequestEncoding,
      onmessage: (msg) => this._onSeedRequest(channel, msg)
    })

    const seedAcceptMsg = channel.addMessage({
      encoding: seedAcceptEncoding,
      onmessage: (msg) => this._onSeedAccept(channel, msg)
    })

    channel._hiverelay = { seedRequestMsg, seedAcceptMsg }
    channel.open(b4a.from(JSON.stringify(PROTOCOL_VERSION)))

    this.channels.add(channel)
    return channel
  }

  /**
   * Publish a seed request to connected relays
   */
  publishSeedRequest (request) {
    const appKeyHex = b4a.toString(request.appKey, 'hex')

    // Sign the request
    if (this.keyPair) {
      const payload = this._serializeForSigning(request)
      request.publisherPubkey = this.keyPair.publicKey
      request.publisherSignature = b4a.alloc(64)
      sodium.crypto_sign_detached(request.publisherSignature, payload, this.keyPair.secretKey)
    }

    if (this.pendingRequests.size >= this._maxPendingRequests) {
      // Evict oldest entry
      const oldest = this.pendingRequests.keys().next().value
      this.pendingRequests.delete(oldest)
    }
    request._addedAt = Date.now()
    this.pendingRequests.set(appKeyHex, request)

    // Broadcast to all connected channels
    for (const channel of this.channels) {
      if (channel.opened && channel._hiverelay) {
        channel._hiverelay.seedRequestMsg.send(request)
      }
    }

    this.emit('request-published', { appKey: appKeyHex })
  }

  /**
   * Accept a seed request (called by relay nodes)
   */
  acceptSeedRequest (appKey, relayPubkey, region, availableStorage) {
    const acceptance = {
      appKey,
      relayPubkey,
      region,
      availableStorageBytes: availableStorage,
      relaySignature: b4a.alloc(64)
    }

    if (this.keyPair) {
      const payload = b4a.concat([appKey, relayPubkey, b4a.from(region)])
      sodium.crypto_sign_detached(acceptance.relaySignature, payload, this.keyPair.secretKey)
    }

    for (const channel of this.channels) {
      if (channel.opened && channel._hiverelay) {
        channel._hiverelay.seedAcceptMsg.send(acceptance)
      }
    }

    this.emit('request-accepted', {
      appKey: b4a.toString(appKey, 'hex'),
      relay: b4a.toString(relayPubkey, 'hex')
    })
  }

  _onSeedRequest (channel, msg) {
    // Get peer key for rate limiting
    const peerKey = channel.stream && channel.stream.remotePublicKey
      ? b4a.toString(channel.stream.remotePublicKey, 'hex')
      : 'unknown'

    // Check rate limit
    const rateCheck = this.rateLimiter.check(peerKey)
    if (!rateCheck.allowed) {
      if (rateCheck.banned) {
        this.emit('rate-limit-exceeded', { peer: peerKey, banned: true, until: rateCheck.bannedUntil })
      }
      return
    }

    // Verify publisher signature
    if (!this._verifyRequestSignature(msg)) {
      this.emit('invalid-request', { appKey: b4a.toString(msg.appKey, 'hex'), reason: 'bad signature' })
      return
    }

    this.emit('seed-request', msg)
  }

  _onSeedAccept (channel, msg) {
    // Get peer key for rate limiting
    const peerKey = channel.stream && channel.stream.remotePublicKey
      ? b4a.toString(channel.stream.remotePublicKey, 'hex')
      : 'unknown'

    // Check rate limit
    const rateCheck = this.rateLimiter.check(peerKey)
    if (!rateCheck.allowed) {
      if (rateCheck.banned) {
        this.emit('rate-limit-exceeded', { peer: peerKey, banned: true, until: rateCheck.bannedUntil })
      }
      return
    }

    // Verify relay signature before processing acceptance
    if (!this._verifyAcceptSignature(msg)) {
      this.emit('invalid-accept', { appKey: b4a.toString(msg.appKey, 'hex'), reason: 'bad signature' })
      return
    }

    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    this.acceptedSeeds.set(appKeyHex, {
      relayPubkey: msg.relayPubkey,
      region: msg.region,
      acceptedAt: Date.now()
    })

    this.emit('seed-accepted', msg)
  }

  _onOpen (channel) {
    // Validate protocol version from handshake
    if (channel.handshake) {
      try {
        const remote = JSON.parse(b4a.toString(channel.handshake))
        if (remote.major !== PROTOCOL_VERSION.major) {
          this.emit('version-mismatch', { local: PROTOCOL_VERSION, remote })
          channel.close()
          return
        }
      } catch {}
    }

    this.emit('channel-open', channel)

    // Send all pending requests to newly connected peer
    for (const request of this.pendingRequests.values()) {
      if (channel._hiverelay) {
        channel._hiverelay.seedRequestMsg.send(request)
      }
    }
  }

  _onClose (channel) {
    this.channels.delete(channel)
    this.emit('channel-close', channel)
  }

  _verifyRequestSignature (msg) {
    if (!msg.publisherPubkey || !msg.publisherSignature) return false
    const payload = this._serializeForSigning(msg)
    return sodium.crypto_sign_verify_detached(msg.publisherSignature, payload, msg.publisherPubkey)
  }

  _verifyAcceptSignature (msg) {
    if (!msg.relayPubkey || !msg.relaySignature) return false
    const payload = b4a.concat([msg.appKey, msg.relayPubkey, b4a.from(msg.region)])
    return sodium.crypto_sign_verify_detached(msg.relaySignature, payload, msg.relayPubkey)
  }

  _serializeForSigning (msg) {
    const parts = [msg.appKey]
    
    // Hash discoveryKeys array to prevent tampering
    // This ensures the entire array is committed to, not just individual elements
    const discoveryKeysHash = b4a.alloc(32)
    if (msg.discoveryKeys && msg.discoveryKeys.length > 0) {
      const dkConcat = b4a.concat(msg.discoveryKeys)
      sodium.crypto_generichash(discoveryKeysHash, dkConcat)
    }
    parts.push(discoveryKeysHash)
    
    const meta = b4a.alloc(28)
    const view = new DataView(meta.buffer, meta.byteOffset)
    view.setUint8(0, msg.replicationFactor)
    view.setBigUint64(8, BigInt(msg.maxStorageBytes))
    view.setBigUint64(16, BigInt(msg.ttlSeconds))
    view.setUint32(24, msg.bountyRate || 0)
    parts.push(meta)
    return b4a.concat(parts)
  }

  _evictStalePending () {
    const now = Date.now()
    for (const [key, req] of this.pendingRequests) {
      const age = now - (req._addedAt || 0)
      if (age > this._pendingTTL) this.pendingRequests.delete(key)
    }
  }

  destroy () {
    clearInterval(this._pendingCleanup)
    for (const channel of this.channels) {
      channel.close()
    }
    this.channels.clear()
    this.pendingRequests.clear()
    this.acceptedSeeds.clear()
    this.rateLimiter.destroy()
  }
}
