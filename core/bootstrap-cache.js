import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'

const CACHE_FILENAME = 'bootstrap-cache.json'
const SAVE_INTERVAL = 15 * 60 * 1000 // 15 minutes
const DEFAULT_MAX_PEERS = 50

export class BootstrapCache {
  constructor (storagePath, opts = {}) {
    this._storagePath = storagePath
    this._filePath = join(storagePath, CACHE_FILENAME)
    this._maxPeers = opts.maxPeers || DEFAULT_MAX_PEERS
    this._enabled = opts.enabled !== false
    this._peers = [] // { host, port, lastSeen }
    this._seenPeers = new Map() // 'host:port' -> { host, port, lastSeen }
    this._interval = null
    this._swarm = null
    this._connectionHandler = null
  }

  async load () {
    if (!this._enabled) return

    try {
      const raw = await readFile(this._filePath, 'utf8')
      const data = JSON.parse(raw)
      if (data && Array.isArray(data.peers)) {
        this._peers = data.peers.slice(0, this._maxPeers)
        for (const p of this._peers) {
          if (p.host && p.port) {
            const key = p.host + ':' + p.port
            this._seenPeers.set(key, { host: p.host, port: p.port, lastSeen: p.lastSeen || 0 })
          }
        }
      }
    } catch {
      // Missing or corrupt cache — start fresh
      this._peers = []
    }
  }

  async save () {
    if (!this._enabled) return

    const peers = this._collectPeers()
    try {
      await mkdir(dirname(this._filePath), { recursive: true })
      const data = {
        updatedAt: Date.now(),
        peers: peers.map(p => ({ host: p.host, port: p.port }))
      }
      await writeFile(this._filePath, JSON.stringify(data, null, 2) + '\n')
    } catch {
      // Best-effort — don't crash if write fails
    }
  }

  merge (configuredBootstrap) {
    if (!this._enabled) return configuredBootstrap || undefined

    const cachedPeers = this._collectPeers()
    if (!cachedPeers.length) return configuredBootstrap || undefined

    const seen = new Set()
    const merged = []

    // Configured bootstrap nodes take priority
    if (configuredBootstrap && Array.isArray(configuredBootstrap)) {
      for (const node of configuredBootstrap) {
        const key = node.host + ':' + node.port
        if (!seen.has(key)) {
          seen.add(key)
          merged.push({ host: node.host, port: node.port })
        }
      }
    }

    // Append cached peers
    for (const p of cachedPeers) {
      const key = p.host + ':' + p.port
      if (!seen.has(key)) {
        seen.add(key)
        merged.push({ host: p.host, port: p.port })
      }
    }

    return merged.length ? merged : (configuredBootstrap || undefined)
  }

  start (swarm) {
    if (!this._enabled) return

    this._swarm = swarm

    // Track peers from swarm connections
    this._connectionHandler = (conn) => {
      const addr = conn.rawStream && conn.rawStream.remoteHost
      const port = conn.rawStream && conn.rawStream.remotePort
      if (addr && port) {
        this._seenPeers.set(addr + ':' + port, { host: addr, port, lastSeen: Date.now() })
      }
    }
    swarm.on('connection', this._connectionHandler)

    // Periodically snapshot to disk
    this._interval = setInterval(() => {
      this.save().catch(() => {})
    }, SAVE_INTERVAL)
    if (this._interval.unref) this._interval.unref()
  }

  stop () {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
    if (this._swarm && this._connectionHandler) {
      this._swarm.removeListener('connection', this._connectionHandler)
      this._connectionHandler = null
    }
    this._swarm = null
  }

  _collectPeers () {
    const all = Array.from(this._seenPeers.values())
    all.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    return all.slice(0, this._maxPeers)
  }
}
