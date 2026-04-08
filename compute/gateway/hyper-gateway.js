/**
 * Hyper Gateway — HTTP endpoint for serving Hyperdrive content
 *
 * Exposes seeded Hyperdrives over HTTP so mobile clients can fetch
 * content without a full P2P connection (fast-path).
 *
 * Uses its own dedicated Corestore + Hyperswarm for content replication,
 * separate from the relay node's protocol swarm. This ensures drive data
 * replicates reliably regardless of when drives are seeded.
 *
 * Designed to be mounted on the existing RelayAPI server.
 *
 * Usage:
 *   const gateway = new HyperGateway(relayNode)
 *   // Add routes to existing API server:
 *   // if (path.startsWith('/v1/hyper/')) return gateway.handle(req, res, path)
 */

import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import { EventEmitter } from 'events'
import { join } from 'path'

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
  wasm: 'application/wasm',
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

    // Dedicated content delivery store + swarm
    // Separate from the relay node's protocol swarm to ensure
    // clean drive replication without connection deduplication issues
    this._store = null
    this._swarm = null
    this._ready = false
  }

  /**
   * Initialize the gateway's own P2P stack for content delivery.
   * Called automatically on first request, or can be called explicitly.
   */
  async _ensureReady () {
    if (this._ready) return

    const storagePath = this.node.config
      ? join(this.node.config.storage || './storage', 'gateway-store')
      : './gateway-store'

    this._store = new Corestore(storagePath)
    await this._store.ready()

    this._swarm = new Hyperswarm()
    this._swarm.on('connection', (conn) => this._store.replicate(conn))

    this._ready = true
    this.emit('ready')
  }

  /**
   * Handle an HTTP request for Hyperdrive content
   * Path format: /v1/hyper/KEY/file/path
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

    // Check if this drive is seeded on the relay
    if (this.node.seededApps && !this.node.seededApps.has(keyHex)) {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'Drive not seeded on this relay' }))
      return
    }

    // Blind apps: relay has encrypted ciphertext, can't serve over HTTP
    const appEntry = this.node.seededApps && this.node.seededApps.get(keyHex)
    if (appEntry && appEntry.blind) {
      res.writeHead(403)
      res.end(JSON.stringify({
        error: 'Private app — encrypted content, P2P access only',
        blind: true,
        hint: 'Use PearBrowser or Hyperswarm to access this app with the encryption key'
      }))
      return
    }

    this._totalRequests++

    try {
      const drive = await this._getDrive(keyHex)
      if (!drive) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Drive not available yet — still replicating' }))
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

      // Rewrite absolute asset paths in HTML so Vite-built apps resolve
      // through the gateway. /assets/foo.js → ./assets/foo.js
      if (contentType.includes('text/html')) {
        let html = content.toString('utf-8')
        html = html.replace(/href="\//g, 'href="./')
          .replace(/src="\//g, 'src="./')
          .replace(/href='\//g, "href='./")
          .replace(/src='\//g, "src='./")
        res.writeHead(200)
        res.end(Buffer.from(html))
      } else {
        res.writeHead(200)
        res.end(content)
      }

      this.emit('served', { keyHex, filePath, bytes: content.length })
    } catch (err) {
      res.writeHead(502)
      res.end(JSON.stringify({ error: err.message }))
    }
  }

  async _getDrive (keyHex) {
    // Return cached drive if already open and has content
    if (this._drives.has(keyHex)) {
      const cached = this._drives.get(keyHex)
      // Refresh in background for next request
      cached.update().catch(() => {})
      return cached
    }

    // Initialize our own P2P stack on first use
    await this._ensureReady()

    try {
      const drive = new Hyperdrive(this._store, Buffer.from(keyHex, 'hex'))
      await drive.ready()

      // Join the drive's discovery key on our dedicated swarm
      const done = drive.findingPeers()
      this._swarm.join(drive.discoveryKey, { server: true, client: true })
      this._swarm.flush().then(done, done)

      // Wait for drive data to arrive from peers
      if (drive.version === 0) {
        try {
          await Promise.race([
            drive.update({ wait: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
          ])
        } catch (_) {}
      }

      // Still no content
      if (drive.version === 0) {
        await drive.close()
        return null
      }

      // Eagerly download all files for future requests
      try {
        const dl = drive.download('/')
        // Don't await — let it download in background
        dl.done().catch(() => {})
      } catch (_) {}

      this._drives.set(keyHex, drive)
      return drive
    } catch (err) {
      this.emit('drive-error', { context: 'getDrive', key: keyHex, error: err })
      return null
    }
  }

  async _serveDirectoryListing (res, drive, keyHex, dirPath) {
    const entries = []
    try {
      for await (const entry of drive.list(dirPath)) {
        entries.push(entry.key)
      }
    } catch (err) {
      this.emit('drive-error', { context: 'directoryListing', key: keyHex, path: dirPath, error: err })
    }

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
      try { await drive.close() } catch (_) {}
    }
    this._drives.clear()

    if (this._swarm) {
      try { await this._swarm.destroy() } catch (_) {}
    }
    if (this._store) {
      try { await this._store.close() } catch (_) {}
    }
  }
}
