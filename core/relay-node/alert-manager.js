/**
 * AlertManager — routes health/lifecycle events to operator channels.
 *
 * Listens for events on the relay node and its subsystems (HealthMonitor,
 * policy guard, services, API, etc.) and dispatches alerts to configured
 * channels (webhook, discord, slack, telegram, email, console).
 *
 * Features:
 *   - Deduplication: same (type, key) fires at most once per cooldown window
 *   - Severity threshold filtering (info < warn < error < critical)
 *   - In-memory alert log (last 100 entries) for /api/alerts
 *   - Channels are independent; a failure in one does not block others
 */

import { EventEmitter } from 'events'

const SEVERITY_ORDER = { info: 0, warn: 1, error: 2, critical: 3 }
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000
const DEFAULT_LOG_SIZE = 100
const DEFAULT_WEBHOOK_TIMEOUT = 5000
const AUTH_FAILURE_THRESHOLD = 10 // per window
const AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000
const SWARM_DISCONNECTED_THRESHOLD_MS = 60 * 1000

export class AlertManager extends EventEmitter {
  constructor (node, config = {}) {
    super()
    this.node = node
    this.config = {
      enabled: config.enabled !== false,
      cooldown: config.cooldown || DEFAULT_COOLDOWN_MS,
      severityThreshold: config.severityThreshold || 'warn',
      logSize: config.logSize || DEFAULT_LOG_SIZE,
      channels: config.channels || {}
    }

    this._log = [] // ring buffer of recent alerts
    this._lastFired = new Map() // "type:key" -> timestamp
    this._authFailures = [] // timestamps of recent auth failures
    this._swarmDisconnectedAt = null

    this._listeners = [] // [{emitter, event, fn}] for teardown
    this._nodemailer = null
    this._nodemailerLoaded = false

    if (this.config.enabled) {
      this._attachListeners()
    }

    // If no channels configured at all, default to console
    const anyChannel = Object.values(this.config.channels).some(c => c && (c.enabled !== false))
    if (!anyChannel) {
      this.config.channels.console = { enabled: true }
    }
  }

  stop () {
    for (const { emitter, event, fn } of this._listeners) {
      try { emitter.removeListener(event, fn) } catch (_) {}
    }
    this._listeners = []
  }

  _on (emitter, event, fn) {
    if (!emitter || typeof emitter.on !== 'function') return
    emitter.on(event, fn)
    this._listeners.push({ emitter, event, fn })
  }

  _attachListeners () {
    const node = this.node

    // Health monitor events (attached lazily since healthMonitor may be
    // created after AlertManager in some start orders — we also listen on
    // the node itself which re-emits health events).
    if (node.healthMonitor) {
      this._on(node.healthMonitor, 'health-warning', (d) => this._onHealthWarning(d))
      this._on(node.healthMonitor, 'health-critical', (d) => this._onHealthCritical(d))
      this._on(node.healthMonitor, 'alert', (a) => this._onHealthAlert(a))
    }

    // Relay node re-emits health events, and emits many lifecycle events
    this._on(node, 'health-warning', (d) => this._onHealthWarning(d))
    this._on(node, 'health-critical', (d) => this._onHealthCritical(d))

    // swarm disconnected — track via swarm-disconnected event, or infer
    // from consecutive zero-connection warnings
    this._on(node, 'swarm-disconnected', (d) => this._onSwarmDisconnected(d))
    this._on(node, 'swarm-reconnected', () => { this._swarmDisconnectedAt = null })

    // Seed lifecycle
    this._on(node, 'seed-failed-permanent', (d) => {
      this.fire({
        type: 'seed-failed-permanent',
        key: d && d.appKey ? String(d.appKey) : 'unknown',
        severity: 'warn',
        message: `Seeding permanently failed for app ${d && d.appKey ? d.appKey : '<unknown>'}`,
        details: d
      })
    })

    // Service lifecycle
    this._on(node, 'service-start-failed', (d) => {
      this.fire({
        type: 'service-start-failed',
        key: d && d.service ? String(d.service) : 'unknown',
        severity: 'critical',
        message: `Service failed to start: ${d && d.service ? d.service : '<unknown>'}`,
        details: d
      })
    })

    // Policy violation (the node re-emits policy guard 'violation' as 'privacy-violation')
    const policyHandler = (d) => {
      this.fire({
        type: 'policy-violation',
        key: (d && (d.rule || d.policy || d.reason)) || 'violation',
        severity: 'warn',
        message: `Policy violation: ${d && (d.rule || d.reason) ? (d.rule || d.reason) : 'unknown'}`,
        details: d
      })
    }
    this._on(node, 'policy-violation', policyHandler)
    this._on(node, 'privacy-violation', policyHandler)

    // Auth failures from the API — emitted on node or api
    const authHandler = (d) => this._onAuthFailure(d)
    this._on(node, 'auth-failure', authHandler)
    if (node.api) this._on(node.api, 'auth-failure', authHandler)
  }

  // --- Event handlers ---

  _onHealthWarning (d) {
    const check = d && d.check ? d.check : 'health'
    let type = 'health-warning'
    const severity = 'warn'
    let message = `Health warning: ${check}`

    if (check === 'memory') {
      type = 'memory-high'
      message = `Memory high — heap ${d.heapPct}%, rss ${d.rssMB}MB`
    } else if (check === 'disk') {
      type = 'disk-low'
      message = `Disk low${d.usedPct ? ` (${d.usedPct}% used)` : ''}`
    } else if (check === 'connections' || check === 'stale-connections') {
      type = 'connections-warning'
      message = `Connections: ${d.reason || check}`
    }

    this.fire({ type, key: check, severity, message, details: d })
  }

  _onHealthCritical (d) {
    const check = d && d.check ? d.check : 'health'
    let type = 'health-check-failed'
    let severity = 'error'
    let message = `Health critical: ${check}${d && d.reason ? ` — ${d.reason}` : ''}`

    if (check === 'swarm') {
      this._onSwarmDisconnected(d)
      return
    }

    // Disk at critical (>=90% already flags warn; if details indicate >=90 flag critical)
    if (check === 'disk' && d && typeof d.usedPct === 'number' && d.usedPct >= 90) {
      type = 'disk-low'
      severity = 'critical'
      message = `Disk critical: ${d.usedPct}% used`
    }

    this.fire({ type, key: check, severity, message, details: d })
  }

  _onHealthAlert (alert) {
    if (!alert || !alert.type) return
    this.fire({
      type: alert.type,
      key: alert.type,
      severity: 'error',
      message: alert.message || `Health alert: ${alert.type}`,
      details: alert
    })
  }

  _onSwarmDisconnected (d) {
    const now = Date.now()
    const duration = (d && typeof d.duration === 'number')
      ? d.duration
      : (this._swarmDisconnectedAt ? now - this._swarmDisconnectedAt : 0)

    if (!this._swarmDisconnectedAt) this._swarmDisconnectedAt = now

    if (duration > SWARM_DISCONNECTED_THRESHOLD_MS) {
      this.fire({
        type: 'swarm-disconnected',
        key: 'swarm',
        severity: 'critical',
        message: `Swarm disconnected for ${Math.round(duration / 1000)}s`,
        details: d
      })
    }
  }

  _onAuthFailure (d) {
    const now = Date.now()
    this._authFailures.push(now)
    // drop old entries
    const cutoff = now - AUTH_FAILURE_WINDOW_MS
    while (this._authFailures.length && this._authFailures[0] < cutoff) {
      this._authFailures.shift()
    }
    if (this._authFailures.length >= AUTH_FAILURE_THRESHOLD) {
      this.fire({
        type: 'auth-failure',
        key: 'excessive',
        severity: 'warn',
        message: `Excessive auth failures: ${this._authFailures.length} in ${Math.round(AUTH_FAILURE_WINDOW_MS / 60000)} min`,
        details: { count: this._authFailures.length, window: AUTH_FAILURE_WINDOW_MS, last: d }
      })
    }
  }

  // --- Public API ---

  /**
   * Fire an alert. Applies severity filter, cooldown dedup, logs,
   * and dispatches to channels.
   *
   * @param {object} alert { type, key, severity, message, details }
   * @returns {boolean} true if dispatched, false if filtered/deduped
   */
  fire (alert) {
    if (!this.config.enabled) return false
    if (!alert || !alert.type) return false

    const severity = alert.severity || 'info'
    const threshold = SEVERITY_ORDER[this.config.severityThreshold] ?? SEVERITY_ORDER.warn
    if ((SEVERITY_ORDER[severity] ?? -1) < threshold) return false

    const key = alert.key || alert.type
    const dedupKey = `${alert.type}:${key}`
    const now = Date.now()
    const last = this._lastFired.get(dedupKey) || 0
    if (now - last < this.config.cooldown) return false
    this._lastFired.set(dedupKey, now)

    const entry = {
      timestamp: now,
      type: alert.type,
      key,
      severity,
      message: alert.message || alert.type,
      details: alert.details || null
    }

    this._append(entry)
    this._dispatch(entry)
    this.emit('alert', entry)
    return true
  }

  /**
   * Fire a manual test alert. Useful for /api/alerts/test.
   */
  fireTest (extra = {}) {
    // Bypass cooldown by stripping any prior marker for this dedup key.
    this._lastFired.delete('test:manual')
    return this.fire({
      type: 'test',
      key: 'manual',
      severity: extra.severity || 'warn',
      message: extra.message || 'Test alert from AlertManager',
      details: extra.details || { source: 'api' }
    })
  }

  /**
   * Get recent alerts. Supports simple pagination.
   * @param {object} opts { offset, limit, severity, type }
   */
  getLog (opts = {}) {
    let items = this._log.slice().reverse() // newest first
    if (opts.severity) items = items.filter(a => a.severity === opts.severity)
    if (opts.type) items = items.filter(a => a.type === opts.type)
    const total = items.length
    const offset = Math.max(0, opts.offset | 0)
    const limit = opts.limit ? Math.max(1, Math.min(500, opts.limit | 0)) : 50
    return {
      total,
      offset,
      limit,
      items: items.slice(offset, offset + limit)
    }
  }

  _append (entry) {
    this._log.push(entry)
    if (this._log.length > this.config.logSize) {
      this._log.splice(0, this._log.length - this.config.logSize)
    }
  }

  _dispatch (entry) {
    const ch = this.config.channels || {}
    if (ch.console && ch.console.enabled !== false) this._sendConsole(entry)
    if (ch.webhook && ch.webhook.url) this._sendWebhook(ch.webhook, entry).catch(() => {})
    if (ch.discord && ch.discord.webhookUrl) this._sendDiscord(ch.discord, entry).catch(() => {})
    if (ch.slack && ch.slack.webhookUrl) this._sendSlack(ch.slack, entry).catch(() => {})
    if (ch.telegram && ch.telegram.botToken && ch.telegram.chatId) {
      this._sendTelegram(ch.telegram, entry).catch(() => {})
    }
    if (ch.email && ch.email.to) this._sendEmail(ch.email, entry).catch(() => {})
  }

  // --- Channel implementations ---

  _sendConsole (entry) {
    const level = entry.severity === 'critical' || entry.severity === 'error' ? 'error' : 'warn'
    const line = `[alert:${entry.severity}] ${entry.type} — ${entry.message}`
    // eslint-disable-next-line no-console
    console[level](line)
  }

  async _sendWebhook (cfg, entry) {
    const body = JSON.stringify(entry)
    await this._postJson(cfg.url, body, cfg.timeout || DEFAULT_WEBHOOK_TIMEOUT, cfg.headers)
  }

  async _sendDiscord (cfg, entry) {
    const color = entry.severity === 'critical'
      ? 0xff0000
      : (entry.severity === 'error' ? 0xff6600 : (entry.severity === 'warn' ? 0xffaa00 : 0x3399ff))
    const payload = {
      embeds: [{
        title: `[${entry.severity.toUpperCase()}] ${entry.type}`,
        description: entry.message,
        color,
        timestamp: new Date(entry.timestamp).toISOString(),
        footer: { text: `key: ${entry.key}` }
      }]
    }
    await this._postJson(cfg.webhookUrl, JSON.stringify(payload), cfg.timeout || DEFAULT_WEBHOOK_TIMEOUT)
  }

  async _sendSlack (cfg, entry) {
    const emoji = entry.severity === 'critical'
      ? ':rotating_light:'
      : (entry.severity === 'error' ? ':x:' : (entry.severity === 'warn' ? ':warning:' : ':information_source:'))
    const payload = {
      text: `${emoji} *[${entry.severity.toUpperCase()}]* ${entry.type}\n${entry.message}\n_key: ${entry.key}_`
    }
    await this._postJson(cfg.webhookUrl, JSON.stringify(payload), cfg.timeout || DEFAULT_WEBHOOK_TIMEOUT)
  }

  async _sendTelegram (cfg, entry) {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`
    const text = `[${entry.severity.toUpperCase()}] ${entry.type}\n${entry.message}`
    const payload = {
      chat_id: cfg.chatId,
      text,
      disable_notification: entry.severity === 'info'
    }
    await this._postJson(url, JSON.stringify(payload), cfg.timeout || DEFAULT_WEBHOOK_TIMEOUT)
  }

  async _sendEmail (cfg, entry) {
    if (!this._nodemailerLoaded) {
      this._nodemailerLoaded = true
      try {
        const mod = await import('nodemailer')
        this._nodemailer = mod.default || mod
      } catch {
        this._nodemailer = null
      }
    }
    if (!this._nodemailer) return // nodemailer not installed — skip silently

    const transport = this._nodemailer.createTransport(cfg.smtp || {})
    await transport.sendMail({
      from: cfg.from || 'hiverelay@localhost',
      to: cfg.to,
      subject: `[hiverelay ${entry.severity}] ${entry.type}`,
      text: `${entry.message}\n\nkey: ${entry.key}\nts: ${new Date(entry.timestamp).toISOString()}\n\nDetails:\n${JSON.stringify(entry.details, null, 2)}`
    })
  }

  async _postJson (urlString, body, timeout, extraHeaders) {
    const url = new URL(urlString)
    const httpMod = await import(url.protocol === 'https:' ? 'https' : 'http')
    const request = httpMod.request || (httpMod.default && httpMod.default.request)

    return new Promise((resolve, reject) => {
      const req = request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(extraHeaders || {})
        },
        timeout
      }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')) })
      req.write(body)
      req.end()
    })
  }
}
