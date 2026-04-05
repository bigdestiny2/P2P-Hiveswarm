/**
 * WebSocket live feed for dashboard clients
 *
 * Pushes real-time stats to connected dashboards instead of
 * requiring them to poll HTTP every 5-10 seconds.
 *
 * Attaches to the existing HTTP server via the upgrade path `/ws`.
 * Broadcasts overview stats every 2 seconds and immediately pushes
 * updates on relay node events (debounced to max 1/sec).
 */

import { WebSocketServer } from 'ws'

const BROADCAST_INTERVAL_MS = 2000
const EVENT_DEBOUNCE_MS = 1000

export class DashboardFeed {
  constructor (opts = {}) {
    this.server = opts.server
    this.node = opts.node
    this.wss = null
    this._broadcastTimer = null
    this._eventDebounceTimer = null
    this._eventListeners = []
    this.clientCount = 0
  }

  start () {
    this.wss = new WebSocketServer({ noServer: true })

    // Handle upgrade requests on path /ws
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })

    this.wss.on('connection', (ws) => {
      this.clientCount++

      ws.on('close', () => {
        this.clientCount--
      })

      ws.on('error', () => {
        // Swallow client errors — the close event will clean up
      })

      // Send an immediate snapshot to new clients
      const snapshot = this._buildPayload()
      if (snapshot) {
        try { ws.send(JSON.stringify(snapshot)) } catch {}
      }
    })

    // Periodic broadcast every 2 seconds
    this._broadcastTimer = setInterval(() => {
      if (this.clientCount === 0) return
      const payload = this._buildPayload()
      if (payload) this._broadcast(payload)
    }, BROADCAST_INTERVAL_MS)
    if (this._broadcastTimer.unref) this._broadcastTimer.unref()

    // Listen for relay node events and push immediate updates
    const events = ['connection', 'connection-closed', 'seeding', 'unseeded', 'circuit-closed']
    for (const evt of events) {
      const handler = () => this._debouncedEventBroadcast()
      this.node.on(evt, handler)
      this._eventListeners.push({ event: evt, handler })
    }

    // Also listen on relay sub-emitter for circuit-closed
    if (this.node.relay) {
      const handler = () => this._debouncedEventBroadcast()
      this.node.relay.on('circuit-closed', handler)
      this._eventListeners.push({ emitter: this.node.relay, event: 'circuit-closed', handler })
    }
  }

  stop () {
    // Clear timers
    if (this._broadcastTimer) {
      clearInterval(this._broadcastTimer)
      this._broadcastTimer = null
    }
    if (this._eventDebounceTimer) {
      clearTimeout(this._eventDebounceTimer)
      this._eventDebounceTimer = null
    }

    // Remove event listeners
    for (const { emitter, event, handler } of this._eventListeners) {
      const target = emitter || this.node
      target.removeListener(event, handler)
    }
    this._eventListeners = []

    // Close all connected clients
    if (this.wss) {
      for (const ws of this.wss.clients) {
        try { ws.close() } catch {}
      }
      this.wss.close()
      this.wss = null
    }

    this.clientCount = 0
  }

  _broadcast (data) {
    if (!this.wss) return
    const msg = JSON.stringify(data)
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        try { ws.send(msg) } catch {}
      }
    }
  }

  _debouncedEventBroadcast () {
    if (this._eventDebounceTimer) return
    this._eventDebounceTimer = setTimeout(() => {
      this._eventDebounceTimer = null
      if (this.clientCount === 0) return
      const payload = this._buildPayload()
      if (payload) this._broadcast(payload)
    }, EVENT_DEBOUNCE_MS)
    if (this._eventDebounceTimer.unref) this._eventDebounceTimer.unref()
  }

  _buildPayload () {
    const node = this.node
    if (!node || !node.running) return null

    const stats = node.getStats()
    const mem = process.memoryUsage()
    const uptimeMs = node.metrics ? Date.now() - node.metrics.startedAt : 0
    const days = Math.floor(uptimeMs / 86400000)
    const h = Math.floor((uptimeMs % 86400000) / 3600000)
    const m = Math.floor((uptimeMs % 3600000) / 60000)
    const parts = []
    if (days > 0) parts.push(`${days}d`)
    if (h > 0) parts.push(`${h}h`)
    parts.push(`${m}m`)

    const config = node.config || {}
    const maxStorage = config.maxStorageBytes || 5368709120
    const bytesStored = stats.seeder ? stats.seeder.totalBytesStored : 0

    const payload = {
      type: 'update',
      timestamp: Date.now(),
      overview: {
        uptime: { ms: uptimeMs, human: parts.join(' ') },
        publicKey: stats.publicKey,
        region: (config.regions && config.regions[0]) || null,
        connections: stats.connections,
        seededApps: stats.seededApps,
        storage: {
          used: bytesStored,
          max: maxStorage,
          pct: maxStorage > 0 ? Math.round(bytesStored / maxStorage * 10000) / 10000 : 0
        },
        relay: stats.relay || { activeCircuits: 0, totalCircuitsServed: 0, totalBytesRelayed: 0 },
        seeder: stats.seeder || { coresSeeded: 0, totalBytesStored: 0, totalBytesServed: 0 },
        memory: { heapUsed: mem.heapUsed, rss: mem.rss },
        errors: node.metrics ? node.metrics._errorCount : 0,
        reputation: node.reputation ? {
          trackedRelays: Object.keys(node.reputation.export()).length,
          topRelay: (() => {
            const lb = node.reputation.getLeaderboard(1)
            return lb.length ? lb[0] : null
          })()
        } : null,
        tor: node.torTransport ? node.torTransport.getInfo() : null,
        bandwidth: node._bandwidthReceipt ? {
          totalProvenBytes: node._bandwidthReceipt.getTotalProvenBandwidth(),
          receiptsIssued: node._bandwidthReceipt._issuedReceipts ? node._bandwidthReceipt._issuedReceipts.length : 0
        } : null
      },
      dashboardClients: this.clientCount
    }

    // Include network discovery state if available
    if (node.networkDiscovery) {
      try {
        payload.network = node.networkDiscovery.getNetworkState()
      } catch {}
    }

    return payload
  }
}
