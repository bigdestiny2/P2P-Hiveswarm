/**
 * Service Registry
 *
 * Manages the catalog of available services on a relay node.
 * Services are headless capabilities that apps consume — storage,
 * compute, identity, payments, zk proofs, AI inference, etc.
 *
 * The registry handles:
 *   - Service registration and lifecycle
 *   - Capability advertisement to peers
 *   - Service discovery (local and remote)
 *   - Version negotiation
 *   - Usage metering (feeds into PaymentManager)
 */

import { EventEmitter } from 'events'
import { compareVersions } from '../constants.js'

const BLOCKED_METHODS = new Set([
  'constructor', 'start', 'stop', 'manifest',
  'toString', 'valueOf', 'toJSON',
  'hasOwnProperty', 'isPrototypeOf'
])

export class ServiceRegistry extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.services = new Map() // name -> ServiceEntry
    this.remoteServices = new Map() // relayPubkey -> [ServiceEntry]
    this.metering = opts.metering !== false
    this.maxServices = opts.maxServices || 64
  }

  /**
   * Register a local service.
   * @param {ServiceProvider} provider - implements the ServiceProvider interface
   */
  register (provider) {
    if (this.services.size >= this.maxServices) {
      throw new Error('SERVICE_LIMIT: max services reached')
    }

    const manifest = provider.manifest()
    if (!manifest.name || !manifest.version) {
      throw new Error('SERVICE_INVALID: manifest requires name and version')
    }

    if (this.services.has(manifest.name)) {
      throw new Error(`SERVICE_EXISTS: ${manifest.name} already registered`)
    }

    const entry = {
      name: manifest.name,
      version: manifest.version,
      capabilities: manifest.capabilities || [],
      description: manifest.description || '',
      provider,
      registeredAt: Date.now(),
      stats: {
        requests: 0,
        errors: 0,
        bytesIn: 0,
        bytesOut: 0
      }
    }

    this.services.set(manifest.name, entry)
    this.emit('service-registered', { name: manifest.name, version: manifest.version })
    return entry
  }

  /**
   * Unregister a service.
   */
  async unregister (name) {
    const entry = this.services.get(name)
    if (!entry) return false

    if (entry.provider.stop) {
      await entry.provider.stop()
    }

    this.services.delete(name)
    this.emit('service-unregistered', { name })
    return true
  }

  /**
   * Handle an incoming RPC request for a service.
   */
  async handleRequest (serviceName, method, params, context) {
    const entry = this.services.get(serviceName)
    if (!entry) {
      throw new Error(`SERVICE_NOT_FOUND: ${serviceName}`)
    }

    // Block dangerous/internal methods from RPC access
    if (BLOCKED_METHODS.has(method)) {
      throw new Error(`METHOD_BLOCKED: ${method}`)
    }

    if (!entry.provider[method] || typeof entry.provider[method] !== 'function') {
      throw new Error(`METHOD_NOT_FOUND: ${serviceName}.${method}`)
    }

    // Enforce capabilities: if the service defines them, only listed methods are callable
    if (entry.capabilities.length > 0 && !entry.capabilities.includes(method)) {
      throw new Error(`METHOD_NOT_ALLOWED: ${method} not in capabilities`)
    }

    entry.stats.requests++

    try {
      const result = await entry.provider[method](params, context)
      return result
    } catch (err) {
      entry.stats.errors++
      throw err
    }
  }

  /**
   * Record a remote relay's advertised services.
   */
  addRemoteServices (relayPubkey, services) {
    this.remoteServices.set(relayPubkey, {
      services,
      lastSeen: Date.now()
    })
    this.emit('remote-services-updated', { relay: relayPubkey, count: services.length })
  }

  /**
   * Find relays that provide a given service.
   */
  findProviders (serviceName, opts = {}) {
    const providers = []

    // Check local first
    if (this.services.has(serviceName)) {
      providers.push({
        relay: 'local',
        service: this.services.get(serviceName),
        local: true
      })
    }

    // Check remote relays
    for (const [relay, info] of this.remoteServices) {
      const svc = info.services.find(s => s.name === serviceName)
      if (svc) {
        if (opts.minVersion && compareVersions(svc.version, opts.minVersion) < 0) continue
        providers.push({
          relay,
          service: svc,
          local: false,
          lastSeen: info.lastSeen
        })
      }
    }

    return providers
  }

  /**
   * Get the full service catalog (for advertising to peers).
   */
  catalog () {
    const entries = []
    for (const [name, entry] of this.services) {
      entries.push({
        name,
        version: entry.version,
        capabilities: entry.capabilities,
        description: entry.description
      })
    }
    return entries
  }

  /**
   * Get stats for all services.
   */
  stats () {
    const result = {}
    for (const [name, entry] of this.services) {
      result[name] = { ...entry.stats }
    }
    return result
  }

  /**
   * Start all registered services.
   */
  async startAll (context) {
    const started = []
    const failed = []

    for (const [name, entry] of this.services) {
      if (entry.provider.start) {
        try {
          await entry.provider.start(context)
          this.emit('service-started', { name })
          started.push(name)
        } catch (err) {
          this.emit('service-start-error', { name, error: err.message })
          failed.push({ name, error: err.message })
        }
      }
    }

    // Fail closed: providers that failed startup are removed so they cannot be dispatched.
    for (const failure of failed) {
      this.services.delete(failure.name)
    }

    return { started, failed }
  }

  /**
   * Stop all registered services.
   */
  async stopAll () {
    for (const [name, entry] of this.services) {
      if (entry.provider.stop) {
        try {
          await entry.provider.stop()
        } catch (err) {
          this.emit('service-stop-error', { name, error: err.message })
        }
      }
    }
    this.services.clear()
    this.remoteServices.clear()
  }
}
