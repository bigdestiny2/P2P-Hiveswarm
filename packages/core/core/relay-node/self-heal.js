import { EventEmitter } from 'events'
import { RELAY_DISCOVERY_TOPIC } from '../constants.js'

const DEFAULT_OPTS = {
  maxRestarts: 3,
  cooldownMs: 60_000
}

const MAX_ACTION_HISTORY = 50

export class SelfHeal extends EventEmitter {
  constructor (node, opts = {}) {
    super()
    this.node = node
    this.opts = { ...DEFAULT_OPTS, ...opts }

    this._healthMonitor = null
    this._actions = []
    this._restartTimestamps = []
    this._lastRestartAt = 0
    this._restarting = false

    this._onWarning = this._onWarning.bind(this)
    this._onCritical = this._onCritical.bind(this)
  }

  start (healthMonitor) {
    this._healthMonitor = healthMonitor
    this._healthMonitor.on('health-warning', this._onWarning)
    this._healthMonitor.on('health-critical', this._onCritical)
  }

  stop () {
    if (this._healthMonitor) {
      this._healthMonitor.removeListener('health-warning', this._onWarning)
      this._healthMonitor.removeListener('health-critical', this._onCritical)
      this._healthMonitor = null
    }
  }

  _recordAction (action) {
    const entry = { ...action, timestamp: Date.now() }
    this._actions.push(entry)
    if (this._actions.length > MAX_ACTION_HISTORY) {
      this._actions.shift()
    }
    this.emit('self-heal-action', entry)
  }

  _onWarning (details) {
    const { check } = details

    if (check === 'memory') {
      // Force GC hint
      if (global.gc) {
        global.gc()
        this._recordAction({ type: 'gc', check, details })
      }

      // Clear caches
      if (this.node.api) {
        this.node.api._dashboardHtml = null
        this.node.api._networkHtml = null
        this._recordAction({ type: 'clear-dashboard-cache', check, details })
      }
      if (this.node.api && this.node.api._rateLimits) {
        this.node.api._rateLimits.clear()
        this._recordAction({ type: 'clear-ratelimit-map', check, details })
      }
      return
    }

    if (check === 'connections') {
      // Re-announce on discovery topic and flush DHT
      if (this.node.swarm && !this.node.swarm.destroyed) {
        this.node.swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
        this.node.swarm.flush().catch(err => {
          this.emit('heal-error', { type: 'dht-flush', error: err.message })
        })
        this._recordAction({ type: 'dht-reannounce', check, details })
      }
      return
    }

    if (check === 'stale-connections') {
      // Destroy stale connections
      const now = Date.now()
      const threshold = this._healthMonitor ? this._healthMonitor.opts.staleConnectionThreshold : 5 * 60 * 1000
      let destroyed = 0
      for (const [conn, entry] of this.node.connections) {
        if (now - entry.lastActivity > threshold) {
          try { conn.destroy() } catch {}
          destroyed++
        }
      }
      this._recordAction({ type: 'destroy-stale-connections', check, destroyed, details })
      return
    }

    if (check === 'errors') {
      this._recordAction({ type: 'error-rate-warning', check, details })
    }
  }

  async _onCritical (details) {
    if (this._restarting) return

    const { check } = details

    // Check restart budget: max N restarts per hour
    const now = Date.now()
    const oneHourAgo = now - 3600_000
    this._restartTimestamps = this._restartTimestamps.filter(t => t > oneHourAgo)

    if (this._restartTimestamps.length >= this.opts.maxRestarts) {
      this._recordAction({ type: 'restart-refused', check, reason: `Exceeded ${this.opts.maxRestarts} restarts per hour`, details })
      return
    }

    // Cooldown check
    if (now - this._lastRestartAt < this.opts.cooldownMs) {
      this._recordAction({ type: 'restart-cooldown', check, reason: 'Cooldown period active', details })
      return
    }

    // Attempt full node restart
    if (check === 'swarm' || check === 'memory') {
      this._restarting = true
      this._restartTimestamps.push(now)
      this._lastRestartAt = now

      this._recordAction({ type: 'full-restart', check, reason: details.reason })

      try {
        await this.node.stop()
        await this.node.start()
        this._recordAction({ type: 'restart-success', check })
      } catch (err) {
        this._recordAction({ type: 'restart-failed', check, error: err.message })
      } finally {
        this._restarting = false
      }
    }
  }

  getActions () {
    return this._actions.slice()
  }
}
