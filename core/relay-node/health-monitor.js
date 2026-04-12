import { EventEmitter } from 'events'
import { statfs } from 'fs/promises'

const DEFAULT_OPTS = {
  checkInterval: 30_000,
  maxHeapPct: 95,
  maxRssMB: 512,
  staleConnectionThreshold: 5 * 60 * 1000,
  zeroConnectionsThreshold: 10 * 60 * 1000,
  maxConsecutiveFailures: 3,
  // Disk monitoring
  maxDiskUsagePct: 90,
  diskCheckPath: null, // Set to storage path
  // Alerting
  alertWebhookUrl: null, // HTTP POST alerts here
  alertCooldownMs: 5 * 60 * 1000 // Don't re-alert within 5 min
}

export class HealthMonitor extends EventEmitter {
  constructor (node, opts = {}) {
    super()
    this.node = node
    this.opts = { ...DEFAULT_OPTS, ...opts }

    this._interval = null
    this._consecutiveMemoryWarnings = 0
    this._zeroConnectionsSince = null
    this._lastErrorCount = 0
    this._lastErrorCheckTime = Date.now()
    this._lastCheck = null

    this._lastAlertTime = new Map() // alert type → timestamp
    this._logBuffer = [] // Ring buffer for recent logs
    this._maxLogBuffer = 500

    this._status = {
      healthy: true,
      checks: {
        memory: { ok: true },
        connections: { ok: true },
        swarm: { ok: true },
        errors: { ok: true },
        disk: { ok: true }
      },
      lastCheck: null,
      consecutiveFailures: 0
    }
  }

  start () {
    if (this._interval) return
    this._interval = setInterval(() => this._check().catch(() => {}), this.opts.checkInterval)
    if (this._interval.unref) this._interval.unref()
    // Run an initial check immediately
    this._check().catch(() => {})
  }

  stop () {
    if (this._interval) {
      clearInterval(this._interval)
      this._interval = null
    }
  }

  async _check () {
    const now = Date.now()
    this._lastCheck = now
    let healthy = true

    // --- Swarm destroyed check ---
    const swarmOk = !!(this.node.swarm && !this.node.swarm.destroyed) || !this.node.running
    this._status.checks.swarm = { ok: swarmOk }
    if (!swarmOk && this.node.running) {
      healthy = false
      this.emit('health-critical', { check: 'swarm', reason: 'Swarm destroyed while node is running' })
    }

    // --- Memory pressure ---
    const mem = process.memoryUsage()
    const heapPct = (mem.heapUsed / mem.heapTotal) * 100
    const rssMB = mem.rss / (1024 * 1024)
    const memoryPressure = heapPct > this.opts.maxHeapPct || rssMB > this.opts.maxRssMB

    if (memoryPressure) {
      this._consecutiveMemoryWarnings++
      healthy = false
      const details = { check: 'memory', heapPct: Math.round(heapPct * 100) / 100, rssMB: Math.round(rssMB * 100) / 100 }

      if (this._consecutiveMemoryWarnings >= this.opts.maxConsecutiveFailures) {
        this._status.checks.memory = { ok: false, critical: true, ...details }
        this.emit('health-critical', { ...details, reason: `Memory pressure persisted for ${this._consecutiveMemoryWarnings} consecutive checks` })
      } else {
        this._status.checks.memory = { ok: false, ...details }
        this.emit('health-warning', details)
      }
    } else {
      this._consecutiveMemoryWarnings = 0
      this._status.checks.memory = { ok: true }
    }

    // --- Zero connections ---
    if (this.node.swarm && !this.node.swarm.destroyed) {
      const connCount = this.node.swarm.connections.size

      if (connCount === 0) {
        if (!this._zeroConnectionsSince) {
          this._zeroConnectionsSince = now
        }
        const zeroDuration = now - this._zeroConnectionsSince
        if (zeroDuration > this.opts.zeroConnectionsThreshold) {
          healthy = false
          this._status.checks.connections = { ok: false, zeroFor: zeroDuration, suggestion: 'DHT re-announce' }
          this.emit('health-warning', { check: 'connections', reason: 'Zero connections', zeroFor: zeroDuration, suggestion: 'DHT re-announce' })
        } else {
          this._status.checks.connections = { ok: true, zeroFor: zeroDuration }
        }
      } else {
        this._zeroConnectionsSince = null

        // --- Stale connections ---
        let staleCount = 0
        for (const [, entry] of this.node.connections) {
          if (now - entry.lastActivity > this.opts.staleConnectionThreshold) {
            staleCount++
          }
        }
        const totalConns = this.node.connections.size
        const stalePct = totalConns > 0 ? (staleCount / totalConns) * 100 : 0

        if (stalePct > 50) {
          healthy = false
          this._status.checks.connections = { ok: false, staleCount, totalConns, stalePct: Math.round(stalePct) }
          this.emit('health-warning', { check: 'stale-connections', staleCount, totalConns, stalePct: Math.round(stalePct) })
        } else {
          this._status.checks.connections = { ok: true, staleCount, totalConns }
        }
      }
    }

    // --- Error rate ---
    const currentErrors = this.node.metrics ? this.node.metrics._errorCount : 0
    const elapsed = (now - this._lastErrorCheckTime) / 60_000 // minutes
    const errorDelta = currentErrors - this._lastErrorCount
    const errorRate = elapsed > 0 ? errorDelta / elapsed : 0

    if (errorRate > 10) {
      healthy = false
      this._status.checks.errors = { ok: false, errorRate: Math.round(errorRate * 100) / 100 }
      this.emit('health-warning', { check: 'errors', errorRate: Math.round(errorRate * 100) / 100, reason: 'Error rate exceeds 10/min' })
    } else {
      this._status.checks.errors = { ok: true, errorRate: Math.round(errorRate * 100) / 100 }
    }

    this._lastErrorCount = currentErrors
    this._lastErrorCheckTime = now

    // --- Disk usage ---
    if (this.opts.diskCheckPath) {
      try {
        const stats = await statfs(this.opts.diskCheckPath)
        const totalBytes = stats.blocks * stats.bsize
        const freeBytes = stats.bavail * stats.bsize
        const usedPct = ((totalBytes - freeBytes) / totalBytes) * 100

        if (usedPct > this.opts.maxDiskUsagePct) {
          healthy = false
          this._status.checks.disk = {
            ok: false,
            usedPct: Math.round(usedPct * 10) / 10,
            freeGB: Math.round(freeBytes / (1024 ** 3) * 10) / 10,
            totalGB: Math.round(totalBytes / (1024 ** 3) * 10) / 10
          }
          this._alert('disk', `Disk usage ${Math.round(usedPct)}% exceeds ${this.opts.maxDiskUsagePct}%`)
        } else {
          this._status.checks.disk = {
            ok: true,
            usedPct: Math.round(usedPct * 10) / 10,
            freeGB: Math.round(freeBytes / (1024 ** 3) * 10) / 10
          }
        }
      } catch (err) {
        this._status.checks.disk = { ok: true, error: err.message }
      }
    }

    // Update overall status
    if (!healthy) {
      this._status.consecutiveFailures++

      // Send alerts for critical issues
      if (this._status.consecutiveFailures >= this.opts.maxConsecutiveFailures) {
        this._alert('consecutive-failures', `${this._status.consecutiveFailures} consecutive health check failures`)
      }
    } else {
      this._status.consecutiveFailures = 0
    }
    this._status.healthy = healthy
    this._status.lastCheck = now
  }

  /**
   * Log an event to the ring buffer.
   */
  log (level, component, message, data = {}) {
    const entry = {
      ts: Date.now(),
      level, // 'info', 'warn', 'error', 'critical'
      component,
      message,
      ...data
    }

    this._logBuffer.push(entry)
    if (this._logBuffer.length > this._maxLogBuffer) {
      this._logBuffer.shift()
    }

    this.emit('log', entry)
  }

  /**
   * Get recent logs, optionally filtered.
   */
  getLogs (opts = {}) {
    let logs = this._logBuffer
    if (opts.level) {
      logs = logs.filter(l => l.level === opts.level)
    }
    if (opts.component) {
      logs = logs.filter(l => l.component === opts.component)
    }
    if (opts.since) {
      logs = logs.filter(l => l.ts >= opts.since)
    }
    if (opts.limit) {
      logs = logs.slice(-opts.limit)
    }
    return logs
  }

  /**
   * Send an alert (webhook POST or event).
   * Respects cooldown to avoid alert fatigue.
   */
  _alert (type, message) {
    const now = Date.now()
    const lastAlert = this._lastAlertTime.get(type) || 0

    if (now - lastAlert < this.opts.alertCooldownMs) return
    this._lastAlertTime.set(type, now)

    const alert = {
      type,
      message,
      timestamp: now,
      status: this._status
    }

    this.emit('alert', alert)
    this.log('critical', 'health-monitor', message, { alertType: type })

    // Fire webhook if configured
    if (this.opts.alertWebhookUrl) {
      this._sendWebhook(alert).catch(() => {})
    }
  }

  async _sendWebhook (alert) {
    try {
      const url = new URL(this.opts.alertWebhookUrl)
      const { request } = await import(url.protocol === 'https:' ? 'https' : 'http')

      return new Promise((resolve, reject) => {
        const req = request({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeout: 10_000
        }, (res) => {
          res.resume()
          resolve()
        })
        req.on('error', reject)
        req.write(JSON.stringify(alert))
        req.end()
      })
    } catch {
      // Webhook failure is non-critical
    }
  }

  getStatus () {
    return { ...this._status }
  }
}
