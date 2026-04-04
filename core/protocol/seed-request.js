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

const PROTOCOL_NAME = 'hiverelay-seed'
const PROTOCOL_VERSION = { major: 1, minor: 0 }

export class SeedProtocol extends EventEmitter {
  constructor (swarm, opts = {}) {
    super()
    this.swarm = swarm
    this.keyPair = opts.keyPair || null
    this.pendingRequests = new Map() // appKey hex -> seed request
    this.acceptedSeeds = new Map() // appKey hex -> { relay pubkey, accepted at }
    this.channels = new Set()
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
    // Verify publisher signature
    if (!this._verifyRequestSignature(msg)) {
      this.emit('invalid-request', { appKey: b4a.toString(msg.appKey, 'hex'), reason: 'bad signature' })
      return
    }

    this.emit('seed-request', msg)
  }

  _onSeedAccept (channel, msg) {
    const appKeyHex = b4a.toString(msg.appKey, 'hex')
    this.acceptedSeeds.set(appKeyHex, {
      relayPubkey: msg.relayPubkey,
      region: msg.region,
      acceptedAt: Date.now()
    })

    this.emit('seed-accepted', msg)
  }

  _onOpen (channel) {
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

  _serializeForSigning (msg) {
    const parts = [msg.appKey]
    for (const dk of msg.discoveryKeys) parts.push(dk)
    const meta = Buffer.alloc(24)
    const view = new DataView(meta.buffer, meta.byteOffset)
    view.setUint8(0, msg.replicationFactor)
    view.setBigUint64(8, BigInt(msg.maxStorageBytes))
    view.setBigUint64(16, BigInt(msg.ttlSeconds))
    parts.push(meta)
    return b4a.concat(parts)
  }

  destroy () {
    for (const channel of this.channels) {
      channel.close()
    }
    this.channels.clear()
    this.pendingRequests.clear()
    this.acceptedSeeds.clear()
  }
}
