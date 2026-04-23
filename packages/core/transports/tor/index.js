/**
 * Tor Hidden Service Transport
 *
 * Provides two capabilities for relay operators:
 *
 * 1. **Hidden service (inbound):** Creates a Tor hidden service so the relay
 *    is reachable via a .onion address. Peers connect without knowing the
 *    relay's real IP. The hidden service forwards to the local Hyperswarm port.
 *
 * 2. **SOCKS5 proxy (outbound):** Routes outbound connections through Tor
 *    so the relay's IP is hidden from peers it connects to.
 *
 * Requirements:
 * - Tor daemon running locally with ControlPort enabled
 * - SOCKS5 proxy available (default: 127.0.0.1:9050)
 * - Control port accessible (default: 127.0.0.1:9051)
 *
 * Tor setup for operators:
 *   apt install tor
 *   # In /etc/tor/torrc:
 *   ControlPort 9051
 *   CookieAuthentication 1
 *   # or: HashedControlPassword <hash>
 *   # Then: systemctl restart tor
 */

import { EventEmitter } from 'events'
import net from 'net'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { SocksClient } from 'socks'
import { Duplex } from 'stream'

const DEFAULT_SOCKS_HOST = '127.0.0.1'
const DEFAULT_SOCKS_PORT = 9050
const DEFAULT_CONTROL_HOST = '127.0.0.1'
const DEFAULT_CONTROL_PORT = 9051
const TOR_CHECK_TIMEOUT = 5000

export class TorTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.socksHost = opts.socksHost || DEFAULT_SOCKS_HOST
    this.socksPort = opts.socksPort || DEFAULT_SOCKS_PORT
    this.controlHost = opts.controlHost || DEFAULT_CONTROL_HOST
    this.controlPort = opts.controlPort || DEFAULT_CONTROL_PORT
    this.controlPassword = opts.controlPassword || null
    this.cookieAuthFile = opts.cookieAuthFile || '/var/lib/tor/control_auth_cookie'
    this.hiddenServiceDir = opts.hiddenServiceDir || null
    this.onionAddress = null
    this.localPort = opts.localPort || null // port to forward hidden service to
    this.running = false
    this._controlSocket = null
    this._connections = new Set()
  }

  /**
   * Start the Tor transport
   * - Verify Tor daemon is running
   * - Optionally create a hidden service
   */
  async start () {
    if (this.running) return

    // 1. Verify Tor SOCKS proxy is reachable
    await this._checkTorRunning()

    // 2. If a local port is specified, create a hidden service
    if (this.localPort) {
      await this._createHiddenService(this.localPort)
    }

    this.running = true
    this.emit('started', {
      socksPort: this.socksPort,
      onionAddress: this.onionAddress
    })
  }

  async stop () {
    if (!this.running) return
    this.running = false

    // Close all active SOCKS connections
    for (const conn of this._connections) {
      conn.destroy()
    }
    this._connections.clear()

    // Close control socket
    if (this._controlSocket) {
      this._controlSocket.destroy()
      this._controlSocket = null
    }

    this.emit('stopped')
  }

  /**
   * Create a SOCKS5 connection through Tor to a .onion address or IP
   * Returns a Duplex stream compatible with Hyperswarm connections
   */
  async connect (host, port) {
    if (!this.running) throw new Error('Tor transport not running')

    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: this.socksHost,
        port: this.socksPort,
        type: 5
      },
      command: 'connect',
      destination: { host, port },
      timeout: 30000
    })

    const stream = new TorStream(socket)
    this._connections.add(stream)

    stream.on('close', () => {
      this._connections.delete(stream)
    })

    this.emit('connection', stream, {
      type: 'tor',
      remoteAddress: host,
      remotePort: port,
      isOnion: host.endsWith('.onion')
    })

    return stream
  }

  /**
   * Check that the Tor SOCKS proxy is reachable
   */
  async _checkTorRunning () {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socksPort, this.socksHost)
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(
          `Tor SOCKS proxy not reachable at ${this.socksHost}:${this.socksPort}. ` +
          'Make sure Tor is running: sudo systemctl start tor'
        ))
      }, TOR_CHECK_TIMEOUT)

      sock.on('connect', () => {
        clearTimeout(timer)
        sock.destroy()
        resolve()
      })

      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(
          `Tor SOCKS proxy not reachable at ${this.socksHost}:${this.socksPort}: ${err.message}. ` +
          'Make sure Tor is running: sudo systemctl start tor'
        ))
      })
    })
  }

  /**
   * Create a Tor hidden service via the control port protocol
   * This dynamically creates a hidden service that forwards .onion:80 -> localhost:localPort
   */
  async _createHiddenService (localPort) {
    const controlSocket = await this._connectControl()

    // Authenticate
    await this._controlAuth(controlSocket)

    // Create ephemeral hidden service
    // ADD_ONION creates a hidden service that lives as long as the control connection
    const response = await this._controlCommand(
      controlSocket,
      `ADD_ONION NEW:BEST Port=${localPort},127.0.0.1:${localPort}`
    )

    // Parse the response to get the .onion address
    const lines = response.split('\n')
    for (const line of lines) {
      if (line.startsWith('250-ServiceID=')) {
        this.onionAddress = line.split('=')[1].trim() + '.onion'
      }
    }

    if (!this.onionAddress) {
      controlSocket.destroy()
      throw new Error('Failed to create hidden service — no ServiceID in response')
    }

    // Keep control socket alive — hidden service dies when it disconnects
    this._controlSocket = controlSocket

    this.emit('hidden-service', { onionAddress: this.onionAddress, localPort })
  }

  /**
   * Connect to the Tor control port
   */
  _connectControl () {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.controlPort, this.controlHost)
      const timer = setTimeout(() => {
        sock.destroy()
        reject(new Error(
          `Tor control port not reachable at ${this.controlHost}:${this.controlPort}. ` +
          'Enable it in /etc/tor/torrc: ControlPort 9051'
        ))
      }, TOR_CHECK_TIMEOUT)

      sock.on('connect', () => {
        clearTimeout(timer)
        resolve(sock)
      })

      sock.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(
          `Tor control port error: ${err.message}. ` +
          'Enable it in /etc/tor/torrc: ControlPort 9051'
        ))
      })
    })
  }

  /**
   * Authenticate with the Tor control port
   * Tries cookie auth first, falls back to password
   */
  async _controlAuth (socket) {
    // Try cookie auth first
    try {
      const cookie = await readFile(this.cookieAuthFile)
      const cookieHex = cookie.toString('hex')
      const response = await this._controlCommand(socket, `AUTHENTICATE ${cookieHex}`)
      if (response.startsWith('250')) return
    } catch {
      // Cookie auth failed — try password
    }

    // Try password auth
    if (this.controlPassword) {
      // Escape quotes in password to prevent command injection
      // Tor control protocol uses double-quoted strings
      const escapedPassword = this.controlPassword.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const response = await this._controlCommand(
        socket,
        `AUTHENTICATE "${escapedPassword}"`
      )
      if (response.startsWith('250')) return
      throw new Error('Tor control authentication failed with password')
    }

    // Try no auth (some configs allow it)
    const response = await this._controlCommand(socket, 'AUTHENTICATE')
    if (response.startsWith('250')) return

    throw new Error(
      'Tor control authentication failed. Configure in /etc/tor/torrc: ' +
      'CookieAuthentication 1 or HashedControlPassword'
    )
  }

  /**
   * Send a command to the Tor control port and wait for the response
   */
  _controlCommand (socket, command) {
    return new Promise((resolve, reject) => {
      let data = ''
      const timer = setTimeout(() => {
        reject(new Error(`Tor control command timed out: ${command.split(' ')[0]}`))
      }, 10000)

      const onData = (chunk) => {
        data += chunk.toString()
        // Tor control protocol: response ends with "250 OK\r\n" or "5xx ...\r\n"
        if (/\r\n$/.test(data) && (/^250 /m.test(data) || /^5\d{2} /m.test(data))) {
          clearTimeout(timer)
          socket.removeListener('data', onData)
          if (/^5\d{2} /m.test(data)) {
            reject(new Error(`Tor control error: ${data.trim()}`))
          } else {
            resolve(data.trim())
          }
        }
      }

      socket.on('data', onData)
      socket.write(command + '\r\n')
    })
  }

  /**
   * Get transport info for display/logging
   */
  getInfo () {
    return {
      running: this.running,
      socksProxy: `${this.socksHost}:${this.socksPort}`,
      onionAddress: this.onionAddress,
      activeConnections: this._connections.size
    }
  }
}

/**
 * Wraps a SOCKS5-established TCP socket into a Duplex stream
 * Compatible with Hyperswarm connection interface
 */
class TorStream extends Duplex {
  constructor (socket, opts = {}) {
    super({ ...opts, allowHalfOpen: false })
    this.socket = socket

    socket.on('data', (data) => {
      if (!this.push(data)) {
        socket.pause()
      }
    })

    socket.on('end', () => {
      this.push(null)
    })

    socket.on('close', () => {
      this.destroy()
    })

    socket.on('error', (err) => {
      this.destroy(err)
    })
  }

  _write (chunk, encoding, cb) {
    if (this.socket.destroyed) {
      cb(new Error('Socket is destroyed'))
      return
    }
    this.socket.write(chunk, encoding, cb)
  }

  _read () {
    if (this.socket && !this.socket.destroyed) {
      this.socket.resume()
    }
  }

  _destroy (err, cb) {
    if (!this.socket.destroyed) {
      this.socket.destroy()
    }
    cb(err)
  }

  get remoteHost () {
    return this.socket.remoteAddress
  }

  get remotePort () {
    return this.socket.remotePort
  }
}
