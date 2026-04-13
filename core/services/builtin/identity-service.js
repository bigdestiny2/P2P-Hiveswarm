/**
 * Identity Service
 *
 * Manages keypair identities and peer verification.
 * Apps use this to verify peer identities, manage local
 * keypairs, and resolve pubkeys to names (if a username
 * registry is available).
 *
 * Capabilities:
 *   - whoami: Get local node identity
 *   - verify: Verify a signed message
 *   - sign: Sign a message with the node's key
 *   - resolve: Resolve a pubkey to a name (if registry available)
 *   - peers: List connected peers and their identity info
 */

import { ServiceProvider } from '../provider.js'
import sodium from 'sodium-universal'
import b4a from 'b4a'

export class IdentityService extends ServiceProvider {
  constructor () {
    super()
    this.node = null
  }

  manifest () {
    return {
      name: 'identity',
      version: '1.0.0',
      description: 'Keypair identity management and peer verification',
      capabilities: ['whoami', 'verify', 'sign', 'resolve', 'peers']
    }
  }

  async start (context) {
    this.node = context.node
  }

  async whoami () {
    return {
      pubkey: this.node.publicKey ? b4a.toString(this.node.publicKey, 'hex') : null,
      name: this.node.config.name || null,
      mode: this.node.mode
    }
  }

  async verify (params) {
    const { message, signature, pubkey } = params
    const msgBuf = b4a.from(message)
    const sigBuf = b4a.from(signature, 'hex')
    const pkBuf = b4a.from(pubkey, 'hex')

    if (sigBuf.length !== sodium.crypto_sign_BYTES) {
      return { valid: false, reason: 'invalid signature length' }
    }
    if (pkBuf.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
      return { valid: false, reason: 'invalid pubkey length' }
    }

    const valid = sodium.crypto_sign_verify_detached(sigBuf, msgBuf, pkBuf)
    return { valid }
  }

  async sign (params, context) {
    if (!this.node.keyPair) {
      throw new Error('NO_KEYPAIR: node has no signing keypair')
    }
    // Remote callers must not be able to sign arbitrary data with the node's key
    if (context?.caller === 'remote') {
      throw new Error('UNAUTHORIZED: sign is not available to remote peers')
    }

    const msgBuf = b4a.from(params.message)
    const sigBuf = b4a.alloc(sodium.crypto_sign_BYTES)
    sodium.crypto_sign_detached(sigBuf, msgBuf, this.node.keyPair.secretKey)

    return {
      message: params.message,
      signature: b4a.toString(sigBuf, 'hex'),
      pubkey: b4a.toString(this.node.keyPair.publicKey, 'hex')
    }
  }

  async resolve (params) {
    // If a username registry is wired up, resolve pubkey -> name
    // For now, return what we know from connected peers
    const { pubkey } = params

    if (this.node.accessControl) {
      const devices = this.node.listDevices()
      const device = devices.find(d => d.pubkey === pubkey)
      if (device) {
        return { pubkey, name: device.name, source: 'device-allowlist' }
      }
    }

    return { pubkey, name: null, source: 'not-found' }
  }

  async peers () {
    const connections = this.node.connections
    if (!connections) return []
    // Handle both Map (production) and Array (test) formats
    const entries = connections instanceof Map
      ? Array.from(connections.values())
      : connections
    if (entries.length === 0) return []
    return entries.map(c => ({
      pubkey: c.remotePubkey || c.remotePubKey || null,
      type: c.type || 'hyperswarm'
    }))
  }
}
