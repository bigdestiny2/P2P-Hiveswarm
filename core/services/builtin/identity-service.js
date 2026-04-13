/**
 * Identity Service
 *
 * Manages keypair identities and peer verification.
 * Apps use this to verify peer identities, manage local
 * keypairs, and resolve pubkeys to names.
 *
 * Integrates with the Identity Protocol Layer (IPL) when available
 * to provide developer identity resolution via attestations and
 * Nostr profile lookup.
 *
 * Capabilities:
 *   - whoami: Get local node identity (+ developer info if attested)
 *   - verify: Verify a signed message
 *   - sign: Sign a message with the node's key
 *   - resolve: Resolve a pubkey to a name (IPL attestation → device allowlist)
 *   - peers: List connected peers and their identity info
 *   - developer: Look up a developer profile and their app keys
 */

import { ServiceProvider } from '../provider.js'
import sodium from 'sodium-universal'
import b4a from 'b4a'

export class IdentityService extends ServiceProvider {
  constructor () {
    super()
    this.node = null
  }

  /** Lazy access to Identity Protocol Layer (initialized after services start) */
  get _ipl () {
    return this.node?.identity || null
  }

  manifest () {
    return {
      name: 'identity',
      version: '1.1.0',
      description: 'Keypair identity management, peer verification, and developer resolution',
      capabilities: ['whoami', 'verify', 'sign', 'resolve', 'peers', 'developer']
    }
  }

  async start (context) {
    this.node = context.node
  }

  async whoami () {
    const result = {
      pubkey: this.node.publicKey ? b4a.toString(this.node.publicKey, 'hex') : null,
      name: this.node.config.name || null,
      mode: this.node.mode
    }

    // Enrich with developer identity if IPL has an attestation for this node's key
    if (this._ipl && result.pubkey) {
      try {
        const dev = await this._ipl.resolveIdentity(result.pubkey)
        if (dev && dev.developerKey) {
          result.developer = {
            key: dev.developerKey,
            profile: dev.profile || null,
            attestedAt: dev.attestation?.timestamp || null
          }
        }
      } catch {}
    }

    return result
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
    const { pubkey } = params

    // Try IPL attestation resolution first
    if (this._ipl) {
      try {
        const dev = await this._ipl.resolveIdentity(pubkey)
        if (dev && dev.developerKey) {
          return {
            pubkey,
            name: dev.profile?.displayName || dev.profile?.name || null,
            developerKey: dev.developerKey,
            source: 'attestation',
            profile: dev.profile || null
          }
        }
      } catch {}
    }

    // Fall back to device allowlist
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

  async developer (params) {
    if (!this._ipl) {
      return { error: 'Identity protocol not available' }
    }

    const { key } = params
    if (!key) {
      throw new Error('MISSING_PARAM: developer key is required')
    }

    const profile = await this._ipl.developers.getProfile(key)
    const apps = this._ipl.attestation.getDeveloperApps(key)

    return {
      developerKey: key,
      profile,
      apps
    }
  }
}
