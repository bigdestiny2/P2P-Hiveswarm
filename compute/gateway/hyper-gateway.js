/**
 * Hyper Gateway — HTTP endpoint for serving Hyperdrive content
 *
 * Exposes seeded Hyperdrives over HTTP so mobile clients can fetch
 * content without a full P2P connection (fast-path).
 *
 * Designed to be mounted on the existing RelayAPI server.
 *
 * Usage:
 *   const gateway = new HyperGateway(relayNode)
 *   // Add routes to existing API server:
 *   // if (path.startsWith('/v1/hyper/')) return gateway.handle(req, res, path)
 */

import Hyperdrive from 'hyperdrive'
import { EventEmitter } from 'events'

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8'
}

function guessType (filePath) {
  const ext = filePath.split('.').pop().toLowerCase()
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

export class HyperGateway extends EventEmitter {
  constructor (relayNode) {
    super()
    this.node = relayNode
    this._drives = new Map() // keyHex → Hyperdrive
    this._totalRequests = 0
    this._totalBytesServed = 0
  }

  /**
   * Handle an HTTP request for Hyperdrive content
   * Path format: /v1/hyper/KEY/file/path
   *
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} path — the full URL path
   */
  async handle (req, res) {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // Parse: /v1/hyper/KEY/path
    const prefix = '/v1/hyper/'
    if (!path.startsWith(prefix)) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid path' }))
      return
    }

    const rest = path.slice(prefix.length)
    const slashIdx = rest.indexOf('/')
    const keyHex = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
    let filePath = slashIdx === -1 ? '/' : rest.slice(slashIdx)

    if (!keyHex || keyHex.length < 52) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid drive key' }))
      return
    }

    this._totalRequests++

    try {
      const drive = await this._getDrive(keyHex)
      if (!drive) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Drive not seeded on this relay' }))
        return
      }

      // Resolve directory → index.html
      if (filePath.endsWith('/') || filePath === '') {
        const entry = await drive.entry((filePath || '/') + 'index.html').catch(() => null)
        if (entry) {
          filePath = (filePath || '/') + 'index.html'
        } else {
          // Directory listing
          return this._serveDirectoryListing(res, drive, keyHex, filePath || '/')
        }
      }

      const content = await drive.get(filePath)
      if (!content) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'File not found', path: filePath }))
        return
      }

      const contentType = guessType(filePath)
      this._totalBytesServed += content.length

      res.setHeader('Content-Type', contentType)
      res.setHeader('X-Hyper-Key', keyHex)
      res.setHeader('X-Served-By', 'hiverelay-gateway')
      res.setHeader('Cache-Control', 'public, max-age=60')
      res.writeHead(200)
      res.end(content)

      this.emit('served', { keyHex, filePath, bytes: content.length })
    } catch (err) {
      res.writeHead(502)
      res.end(JSON.stringify({ error: err.message }))
    }
  }

  async _getDrive (keyHex) {
    // Check cache
    if (this._drives.has(keyHex)) return this._drives.get(keyHex)

    // Check if the relay has this drive seeded
    if (!this.node.store) return null

    try {
      const drive = new Hyperdrive(this.node.store, Buffer.from(keyHex, 'hex'))
      await drive.ready()

      // Only serve if we actually have content (version > 0)
      if (drive.version === 0) {
        await drive.close()
        return null
      }

      this._drives.set(keyHex, drive)
      return drive
    } catch {
      return null
    }
  }

  async _serveDirectoryListing (res, drive, keyHex, dirPath) {
    const entries = []
    try {
      for await (const entry of drive.list(dirPath)) {
        entries.push(entry.key)
      }
    } catch {}

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('X-Hyper-Key', keyHex)
    res.setHeader('X-Served-By', 'hiverelay-gateway')
    res.writeHead(200)
    res.end(JSON.stringify({ key: keyHex, path: dirPath, entries }))
  }

  getStats () {
    return {
      cachedDrives: this._drives.size,
      totalRequests: this._totalRequests,
      totalBytesServed: this._totalBytesServed
    }
  }

  async close () {
    for (const [, drive] of this._drives) {
      try { await drive.close() } catch {}
    }
    this._drives.clear()
  }
}
