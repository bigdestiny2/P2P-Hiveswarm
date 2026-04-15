/**
 * Hyper Gateway — HTTP endpoint for serving Hyperdrive content
 *
 * Exposes seeded Hyperdrives over HTTP so mobile clients can fetch
 * content without a full P2P connection (fast-path).
 *
 * When a Corestore is provided via `opts.store`, the gateway creates a
 * namespaced session instead of spinning up a separate P2P stack — halving
 * memory usage. Falls back to a dedicated Corestore + Hyperswarm when no
 * store is given (standalone / backward-compatible mode).
 *
 * Designed to be mounted on the existing RelayAPI server.
 *
 * Usage:
 *   const gateway = new HyperGateway(relayNode, { store: relayNode.store })
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
  // Extract extension safely, handling edge cases
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const filename = filePath.slice(lastSlash + 1)
  const lastDot = filename.lastIndexOf('.')
  if (lastDot <= 0) return 'application/octet-stream' // No extension or hidden file
  const ext = filename.slice(lastDot + 1).toLowerCase()
  return CONTENT_TYPES[ext] || 'application/octet-stream'
}

/**
 * Simple LRU cache for Hyperdrive instances
 * Tracks access order and evicts least recently used when limit exceeded
 *
 * @param {number} [maxSize=20] — maximum number of cached drives
 */
class DriveCache {
  constructor (maxSize = 20) {
    this.maxSize = maxSize
    this.cache = new Map() // key → { drive, lastAccess }
  }

  get (key) {
    const entry = this.cache.get(key)
    if (entry) {
      entry.lastAccess = Date.now()
      // Re-insert to maintain access order
      this.cache.delete(key)
      this.cache.set(key, entry)
    }
    return entry?.drive || null
  }

  set (key, drive) {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value
      const oldestEntry = this.cache.get(oldestKey)
      this.cache.delete(oldestKey)
      // Close the evicted drive (non-blocking)
      if (oldestEntry?.drive && !oldestEntry.drive.closed) {
        oldestEntry.drive.close().catch(err => {
          this.emit?.('drive-cache-error', { operation: 'evict-close', error: err.message })
        })
      }
    }
    this.cache.delete(key)
    this.cache.set(key, { drive, lastAccess: Date.now() })
  }

  has (key) {
    return this.cache.has(key)
  }

  delete (key) {
    this.cache.delete(key)
  }

  clear () {
    this.cache.clear()
  }

  get size () {
    return this.cache.size
  }

  entries () {
    return this.cache.entries()
  }
}

export class HyperGateway extends EventEmitter {
  constructor (relayNode, opts = {}) {
    super()
    this.node = relayNode
    this._drives = new DriveCache(opts.maxCachedDrives || 20) // LRU cache
    this._totalRequests = 0
    this._totalBytesServed = 0
    this._driveOperationTimeout = opts.driveOperationTimeout || 30000 // 30s default

    // If a Corestore is provided (e.g. the relay node's store), create a
    // namespaced session instead of spinning up an entirely separate P2P stack.
    // This halves memory usage by sharing storage and the existing swarm.
    this._externalStore = opts.store || null
    this._store = null
    this._swarm = null
    this._ownsSwarm = false
    this._ready = false
  }

  /**
   * Wrap a promise with a timeout
   */
  _withTimeout (promise, ms, context) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${context} timed out after ${ms}ms`)), ms)
      )
    ])
  }

  /**
   * Initialize the gateway's own P2P stack for content delivery.
   * Called automatically on first request, or can be called explicitly.
   */
  async _ensureReady () {
    if (this._ready) return

    if (this._externalStore) {
      // Re-use the relay node's Corestore via a namespaced session —
      // avoids creating a second Corestore + Hyperswarm (Fix 2.1).
      this._store = this._externalStore.namespace('gateway')
      await this._store.ready()
      // The relay node's swarm already calls store.replicate(conn),
      // which covers namespaced sessions, so no extra swarm is needed.
    } else {
      // Standalone / backward-compatible mode: own store + swarm
      const storagePath = this.node.config
        ? join(this.node.config.storage || './storage', 'gateway-store')
        : './gateway-store'

      this._store = new Corestore(storagePath)
      await this._store.ready()

      this._swarm = new Hyperswarm()
      this._swarm.on('connection', (conn) => this._store.replicate(conn))
      this._ownsSwarm = true
    }

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

    // Reject path traversal attempts
    // Block: .. (parent dir), null bytes, absolute paths, URL-encoded variants
    const decodedPath = decodeURIComponent(filePath)
    const doubleDecodedPath = decodeURIComponent(decodedPath)

    if (
      decodedPath.includes('..') ||
      doubleDecodedPath.includes('..') ||
      filePath.includes('\x00') ||
      decodedPath.includes('\x00') ||
      /^[a-zA-Z]:/.test(decodedPath) // Windows absolute paths
    ) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'Invalid path' }))
      return
    }

    if (!keyHex || keyHex.length !== 64 || !/^[0-9a-f]+$/i.test(keyHex)) {
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

      // Resolve directory → index.html (with timeout)
      if (filePath.endsWith('/') || filePath === '') {
        const entry = await this._withTimeout(
          drive.entry((filePath || '/') + 'index.html'),
          this._driveOperationTimeout,
          'drive.entry()'
        ).catch(() => null)
        if (entry) {
          filePath = (filePath || '/') + 'index.html'
        } else {
          // Directory listing
          return this._serveDirectoryListing(res, drive, keyHex, filePath || '/')
        }
      }

      // Check that the file exists via entry() — also gives us byte length
      const entry = await this._withTimeout(
        drive.entry(filePath),
        this._driveOperationTimeout,
        'drive.entry()'
      )
      if (!entry || !entry.value.blob) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'File not found', path: filePath }))
        return
      }

      const contentType = guessType(filePath)
      const byteLength = entry.value.blob.byteLength

      res.setHeader('Content-Type', contentType)
      res.setHeader('X-Hyper-Key', keyHex)
      res.setHeader('X-Served-By', 'hiverelay-gateway')
      res.setHeader('Cache-Control', 'public, max-age=60')

      // HTML needs base-URL rewriting so Vite-built apps resolve assets
      // through the gateway.  /assets/foo.js → ./assets/foo.js
      // This requires buffering the full response (typically small).
      if (contentType.includes('text/html')) {
        const content = await this._withTimeout(
          drive.get(filePath),
          this._driveOperationTimeout,
          'drive.get()'
        )
        if (!content) {
          res.writeHead(404)
          res.end(JSON.stringify({ error: 'File not found', path: filePath }))
          return
        }
        let html = content.toString('utf-8')
        html = html.replace(/href="\//g, 'href="./')
          .replace(/src="\//g, 'src="./')
          .replace(/href='\//g, "href='./")
          .replace(/src='\//g, "src='./")
        const buf = Buffer.from(html)
        this._totalBytesServed += buf.length
        res.writeHead(200, { 'Content-Length': buf.length })
        res.end(buf)
        this.emit('served', { keyHex, filePath, bytes: buf.length })
      } else {
        // Stream non-HTML content directly — avoids buffering large
        // binaries (images, WASM, video, etc.) in memory (Fix 2.2).
        if (byteLength != null) {
          res.setHeader('Content-Length', byteLength)
        }
        res.writeHead(200)

        const stream = drive.createReadStream(filePath)
        let bytes = 0

        stream.on('data', (chunk) => { bytes += chunk.length })
        stream.on('end', () => {
          this._totalBytesServed += bytes
          this.emit('served', { keyHex, filePath, bytes })
        })
        stream.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502)
          }
          res.end(JSON.stringify({ error: err.message }))
          this.emit('drive-error', { context: 'stream', key: keyHex, path: filePath, error: err.message })
        })
        stream.pipe(res)
      }
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
      cached.update().catch(err => {
        this.emit('drive-update-error', { key: keyHex, error: err.message })
      })
      return cached
    }

    // Initialize our own P2P stack on first use
    await this._ensureReady()

    try {
      const drive = new Hyperdrive(this._store, Buffer.from(keyHex, 'hex'))
      await drive.ready()

      // Join the drive's discovery key on the swarm (only when we own it)
      if (this._swarm) {
        const done = drive.findingPeers()
        this._swarm.join(drive.discoveryKey, { server: true, client: true })
        this._swarm.flush().then(done, done)
      }

      // Wait for drive data to arrive from peers
      if (drive.version === 0) {
        try {
          await Promise.race([
            drive.update({ wait: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000))
          ])
        } catch (err) {
          this.emit('drive-wait-error', { key: keyHex, error: err.message })
        }
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
        dl.done().catch(err => {
          this.emit('drive-download-error', { key: keyHex, error: err.message })
        })
      } catch (err) {
        this.emit('drive-download-init-error', { key: keyHex, error: err.message })
      }

      this._drives.set(keyHex, drive)
      return drive
    } catch (err) {
      this.emit('drive-error', { context: 'getDrive', key: keyHex, error: err })
      return null
    }
  }

  async _serveDirectoryListing (res, drive, keyHex, dirPath) {
    const entries = []
    const MAX_ENTRIES = 1000 // Prevent memory exhaustion from huge directories
    const startTime = Date.now()
    const TIMEOUT = this._driveOperationTimeout

    try {
      for await (const entry of drive.list(dirPath)) {
        // Check timeout
        if (Date.now() - startTime > TIMEOUT) {
          throw new Error('Directory listing timeout')
        }
        entries.push(entry.key)
        // Limit entries
        if (entries.length >= MAX_ENTRIES) {
          entries.push('... (truncated)')
          break
        }
      }
    } catch (err) {
      this.emit('drive-error', { context: 'directoryListing', key: keyHex, path: dirPath, error: err.message })
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
      try { await drive.close() } catch (err) {
        this.emit('drive-close-error', { error: err.message })
      }
    }
    this._drives.clear()

    if (this._ownsSwarm && this._swarm) {
      try { await this._swarm.destroy() } catch (err) {
        this.emit('swarm-destroy-error', { error: err.message })
      }
    }
    if (this._store) {
      try { await this._store.close() } catch (err) {
        this.emit('store-close-error', { error: err.message })
      }
    }
  }
}
