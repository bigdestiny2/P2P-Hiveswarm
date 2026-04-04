/**
 * WebSocket-to-Duplex Stream Adapter
 *
 * Wraps a `ws` WebSocket into a Node.js Duplex stream so it can be
 * used interchangeably with Hyperswarm connections in the relay pipeline.
 */

import { Duplex } from 'stream'

export class WebSocketStream extends Duplex {
  constructor (ws, opts = {}) {
    super({
      ...opts,
      allowHalfOpen: false
    })
    this.ws = ws
    this._opened = ws.readyState === 1 // WebSocket.OPEN

    ws.on('message', (data) => {
      // data arrives as Buffer or ArrayBuffer — ensure Buffer
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (!this.push(buf)) {
        // Backpressure: pause the WebSocket until _read() is called
        ws.pause()
      }
    })

    ws.on('close', () => {
      this.push(null) // Signal EOF on readable side
      this.destroy()
    })

    ws.on('error', (err) => {
      this.destroy(err)
    })
  }

  _write (chunk, encoding, cb) {
    if (this.ws.readyState !== 1) {
      cb(new Error('WebSocket is not open'))
      return
    }

    // ws.send supports a callback for backpressure
    this.ws.send(chunk, (err) => {
      if (err) {
        cb(err)
        return
      }
      cb()
    })
  }

  _read () {
    // Resume the WebSocket if it was paused due to backpressure
    if (this.ws && typeof this.ws.resume === 'function') {
      this.ws.resume()
    }
  }

  _destroy (err, cb) {
    if (this.ws.readyState === 1 || this.ws.readyState === 0) {
      this.ws.close()
    }
    cb(err)
  }
}
