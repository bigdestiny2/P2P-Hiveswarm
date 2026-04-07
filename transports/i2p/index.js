/**
 * I2P Transport
 *
 * Routes Hyperswarm connections through the I2P network using the SAM API.
 * Better suited for P2P relay than Tor — I2P is designed for internal
 * hidden services, and every node routes by default.
 *
 * Requirements:
 * - I2P router running locally (i2pd or Java I2P)
 * - SAM bridge enabled (default: 127.0.0.1:7656)
 *
 * Status: NOT IMPLEMENTED — Phase 2 stub only.
 * All methods throw. Do not enable in production config.
 */

import { EventEmitter } from 'events'

const DEFAULT_SAM_HOST = '127.0.0.1'
const DEFAULT_SAM_PORT = 7656

export class I2PTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.samHost = opts.samHost || DEFAULT_SAM_HOST
    this.samPort = opts.samPort || DEFAULT_SAM_PORT
    this.destination = null // I2P destination (like .onion address)
    this.running = false
  }

  async start () {
    // TODO: Phase 2 implementation
    // 1. Connect to SAM bridge
    // 2. Create session (STREAM or DATAGRAM)
    // 3. Get local I2P destination
    // 4. Accept incoming connections
    throw new Error('I2P transport not yet implemented — Phase 2')
  }

  async stop () {
    this.running = false
  }

  async connect (i2pDestination) {
    // TODO: SAM STREAM CONNECT to destination
    throw new Error('Not implemented')
  }

  async listen () {
    // TODO: SAM STREAM ACCEPT
    throw new Error('Not implemented')
  }
}
