import { EventEmitter } from 'events'

const MAX_SNAPSHOTS = 1440 // 24 hours of minutely snapshots

export class Metrics extends EventEmitter {
  constructor (relayNode) {
    super()
    this.node = relayNode
    this.startedAt = Date.now()
    this._errorCount = 0

    // Circular buffer for snapshots
    this._buf = new Array(MAX_SNAPSHOTS)
    this._head = 0
    this._size = 0
    this.snapshotInterval = null

    // Track connection errors
    this.node.on('connection-error', () => { this._errorCount++ })

    this._startSnapshots()
  }

  _startSnapshots () {
    // Take a snapshot every 60 seconds
    this.snapshotInterval = setInterval(() => {
      this._buf[this._head] = {
        timestamp: Date.now(),
        ...this.node.getStats()
      }
      this._head = (this._head + 1) % MAX_SNAPSHOTS
      if (this._size < MAX_SNAPSHOTS) this._size++
    }, 60_000)
  }

  get snapshots () {
    if (this._size === 0) return []
    if (this._size < MAX_SNAPSHOTS) {
      return this._buf.slice(0, this._size)
    }
    // Wrap around: oldest is at _head, newest is at _head - 1
    return [...this._buf.slice(this._head), ...this._buf.slice(0, this._head)]
  }

  getSummary () {
    const stats = this.node.getStats()
    const uptimeMs = Date.now() - this.startedAt

    return {
      uptime: {
        ms: uptimeMs,
        hours: Math.round(uptimeMs / 3600000 * 100) / 100,
        human: this._formatUptime(uptimeMs)
      },
      current: stats,
      snapshotCount: this._size
    }
  }

  // Prometheus-compatible metrics output
  toPrometheus () {
    const stats = this.node.getStats()
    const uptimeMs = Date.now() - this.startedAt
    const lines = []

    lines.push('# HELP hiverelay_uptime_seconds Relay node uptime in seconds')
    lines.push('# TYPE hiverelay_uptime_seconds gauge')
    lines.push(`hiverelay_uptime_seconds ${Math.round(uptimeMs / 1000)}`)

    lines.push('# HELP hiverelay_seeded_apps Number of apps being seeded')
    lines.push('# TYPE hiverelay_seeded_apps gauge')
    lines.push(`hiverelay_seeded_apps ${stats.seededApps}`)

    lines.push('# HELP hiverelay_connections Active peer connections')
    lines.push('# TYPE hiverelay_connections gauge')
    lines.push(`hiverelay_connections ${stats.connections}`)

    if (stats.seeder) {
      lines.push('# HELP hiverelay_cores_seeded Number of Hypercores being seeded')
      lines.push('# TYPE hiverelay_cores_seeded gauge')
      lines.push(`hiverelay_cores_seeded ${stats.seeder.coresSeeded}`)

      lines.push('# HELP hiverelay_bytes_stored Total bytes stored on disk')
      lines.push('# TYPE hiverelay_bytes_stored gauge')
      lines.push(`hiverelay_bytes_stored ${stats.seeder.totalBytesStored}`)

      lines.push('# HELP hiverelay_bytes_served Total bytes served to peers')
      lines.push('# TYPE hiverelay_bytes_served counter')
      lines.push(`hiverelay_bytes_served ${stats.seeder.totalBytesServed}`)
    }

    if (stats.relay) {
      lines.push('# HELP hiverelay_active_circuits Active relay circuits')
      lines.push('# TYPE hiverelay_active_circuits gauge')
      lines.push(`hiverelay_active_circuits ${stats.relay.activeCircuits}`)

      lines.push('# HELP hiverelay_total_circuits_served Total circuits served')
      lines.push('# TYPE hiverelay_total_circuits_served counter')
      lines.push(`hiverelay_total_circuits_served ${stats.relay.totalCircuitsServed}`)

      lines.push('# HELP hiverelay_bytes_relayed Total bytes relayed')
      lines.push('# TYPE hiverelay_bytes_relayed counter')
      lines.push(`hiverelay_bytes_relayed ${stats.relay.totalBytesRelayed}`)
    }

    // Process metrics
    const mem = process.memoryUsage()
    lines.push('# HELP hiverelay_process_heap_bytes Process heap memory in bytes')
    lines.push('# TYPE hiverelay_process_heap_bytes gauge')
    lines.push(`hiverelay_process_heap_bytes ${mem.heapUsed}`)

    lines.push('# HELP hiverelay_process_rss_bytes Process resident set size in bytes')
    lines.push('# TYPE hiverelay_process_rss_bytes gauge')
    lines.push(`hiverelay_process_rss_bytes ${mem.rss}`)

    // Error counter
    lines.push('# HELP hiverelay_errors_total Total connection errors')
    lines.push('# TYPE hiverelay_errors_total counter')
    lines.push(`hiverelay_errors_total ${this._errorCount}`)

    return lines.join('\n') + '\n'
  }

  _formatUptime (ms) {
    const days = Math.floor(ms / 86400000)
    const hours = Math.floor((ms % 86400000) / 3600000)
    const minutes = Math.floor((ms % 3600000) / 60000)
    const parts = []
    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    parts.push(`${minutes}m`)
    return parts.join(' ')
  }

  stop () {
    if (this.snapshotInterval) {
      clearInterval(this.snapshotInterval)
      this.snapshotInterval = null
    }
  }
}
