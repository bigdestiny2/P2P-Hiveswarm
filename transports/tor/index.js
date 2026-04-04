/**
 * Tor Hidden Service Transport
 *
 * Wraps Hyperswarm connections in Tor circuits via .onion addresses.
 * Provides censorship resistance and IP anonymity for relay nodes and peers.
 *
 * Requirements:
 * - Tor daemon running locally (tor service or tor binary)
 * - SOCKS5 proxy available (default: 127.0.0.1:9050)
 * - Hidden service directory configured
 *
 * Status: STUB — Phase 2+ implementation
 */

import { EventEmitter } from 'events'

const DEFAULT_SOCKS_PORT = 9050
const DEFAULT_SOCKS_HOST = '127.0.0.1'

export class TorTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.socksHost = opts.socksHost || DEFAULT_SOCKS_HOST
    this.socksPort = opts.socksPort || DEFAULT_SOCKS_PORT
    this.onionAddress = null
    this.running = false
  }

  async start () {
    // TODO: Phase 2 implementation
    // 1. Check Tor daemon is running
    // 2. Create hidden service via Tor control port
    // 3. Get .onion address
    // 4. Configure SOCKS5 proxy for outbound connections
    throw new Error('Tor transport not yet implemented — Phase 2')
  }

  async stop () {
    this.running = false
  }

  /**
   * Wrap an outbound connection through Tor SOCKS proxy
   */
  async connect (onionAddress, port) {
    // TODO: SOCKS5 connect through Tor
    throw new Error('Not implemented')
  }

  /**
   * Create a listening hidden service
   */
  async listen (localPort) {
    // TODO: Configure Tor hidden service pointing to localPort
    throw new Error('Not implemented')
  }
}
