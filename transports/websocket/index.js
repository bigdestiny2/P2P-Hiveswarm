/**
 * WebSocket Transport
 *
 * Enables browser peers to connect to the HiveRelay network.
 * Wraps incoming WebSocket connections into duplex streams that
 * integrate with the existing Protomux/Hyperswarm protocol stack.
 *
 * Connections from WebSocket clients are treated identically to
 * Hyperswarm connections — they can seed, relay, and participate
 * in proof-of-relay.
 */

import { EventEmitter } from 'events'
import { WebSocketServer } from 'ws'
import { WebSocketStream } from './stream.js'

const DEFAULT_WS_PORT = 8765

export class WebSocketTransport extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.port = opts.port || DEFAULT_WS_PORT
    this.host = opts.host || '0.0.0.0'
    this.maxConnections = opts.maxConnections || 256
    this.server = null
    this.connections = new Set()
    this.running = false
  }

  async start () {
    if (this.running) return

    this.server = new WebSocketServer({
      port: this.port,
      host: this.host,
      maxPayload: 64 * 1024 * 1024, // 64 MB max message
      perMessageDeflate: false // disable compression for raw binary perf
    })

    await new Promise((resolve, reject) => {
      this.server.on('listening', resolve)
      this.server.on('error', reject)
    })

    this.server.on('connection', (ws, req) => {
      if (this.connections.size >= this.maxConnections) {
        ws.close(1013, 'RELAY_AT_CAPACITY')
        return
      }

      const stream = new WebSocketStream(ws)
      this.connections.add(stream)

      const info = {
        type: 'websocket',
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort
      }

      stream.on('close', () => {
        this.connections.delete(stream)
        this.emit('disconnection', { info })
      })

      stream.on('error', () => {
        this.connections.delete(stream)
      })

      this.emit('connection', stream, info)
    })

    this.server.on('error', (err) => {
      this.emit('error', err)
    })

    this.running = true
    this.emit('started', { port: this.port, host: this.host })
  }

  async stop () {
    if (!this.running) return
    this.running = false

    // Close all active connections
    for (const stream of this.connections) {
      stream.destroy()
    }
    this.connections.clear()

    // Close the server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve())
      })
      this.server = null
    }

    this.emit('stopped')
  }
}
