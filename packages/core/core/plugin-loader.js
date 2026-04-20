/**
 * PluginLoader — Config-driven plugin architecture for services
 *
 * Loads service providers from config instead of hardcoding imports.
 * Builtin shortnames (e.g. 'ai', 'identity') resolve to classes exported by
 * the optional `p2p-hiveservices` package — Core itself ships no service
 * implementations. If `p2p-hiveservices` is not installed and an operator
 * lists a builtin shortname, the loader throws a clear error.
 *
 * Config examples:
 *   plugins: ['storage', 'identity', 'ai']              // builtin shortnames
 *   plugins: ['./my-plugin.js']                         // path to module
 *   plugins: [{ path: './my-plugin.js', options: {} }]  // with options
 */

import { join } from 'path'
import { pathToFileURL } from 'url'

// Builtin shortname -> { module subpath of p2p-hiveservices, exported className }
const BUILTIN_MAP = {
  storage: { module: 'p2p-hiveservices/builtin/storage-service.js', className: 'StorageService' },
  identity: { module: 'p2p-hiveservices/builtin/identity-service.js', className: 'IdentityService' },
  ai: { module: 'p2p-hiveservices/builtin/ai-service.js', className: 'AIService' },
  zk: { module: 'p2p-hiveservices/builtin/zk-service.js', className: 'ZKService' },
  sla: { module: 'p2p-hiveservices/builtin/sla-service.js', className: 'SLAService' },
  schema: { module: 'p2p-hiveservices/builtin/schema-service.js', className: 'SchemaService' },
  arbitration: { module: 'p2p-hiveservices/builtin/arbitration-service.js', className: 'ArbitrationService' }
}

export class PluginLoader {
  constructor (opts = {}) {
    this.plugins = []
    this._builtinDir = opts.builtinDir || null
  }

  /**
   * Load plugins from a config array.
   * Each entry can be:
   *   - A string name matching a builtin (e.g. 'ai', 'storage', 'identity')
   *   - A string path (relative or absolute) to a module with a default export
   *   - An object { path, options } for plugins needing config
   */
  async load (pluginConfigs, context = {}) {
    const providers = []

    for (const entry of pluginConfigs) {
      let provider

      if (typeof entry === 'string') {
        if (entry === '__proto__' || entry === 'constructor' || entry === 'prototype') {
          throw new Error('PluginLoader: invalid plugin name')
        }
        if (BUILTIN_MAP[entry]) {
          provider = await this.loadBuiltin(entry, context)
        } else {
          provider = await this._loadFromPath(entry)
        }
      } else if (entry && typeof entry === 'object') {
        if (entry.path) {
          provider = await this._loadFromPath(entry.path, entry.options)
        } else {
          throw new Error('PluginLoader: object entry must have a "path" property')
        }
      } else {
        throw new Error('PluginLoader: invalid plugin config entry: ' + String(entry))
      }

      this.validate(provider)
      this.plugins.push(provider)
      providers.push(provider)
    }

    return providers
  }

  /**
   * Load a single builtin service by shortname. Resolves to a class exported by
   * the p2p-hiveservices package (which must be installed alongside Core).
   *
   * @param {string} name - One of: storage, identity, ai, zk, sla, schema, arbitration
   * @param {object} context - Optional context passed to constructors that need it
   * @returns {object} Instantiated service provider
   */
  async loadBuiltin (name, context = {}) {
    const info = BUILTIN_MAP[name]
    if (!info) {
      throw new Error('PluginLoader: unknown builtin "' + name + '"')
    }

    let mod
    try {
      mod = await import(info.module)
    } catch (err) {
      throw new Error(
        'PluginLoader: builtin "' + name + '" requires p2p-hiveservices to be installed. ' +
        'Install it with: npm install p2p-hiveservices. (' + err.message + ')'
      )
    }
    const Ctor = mod[info.className]

    if (!Ctor) {
      throw new Error('PluginLoader: builtin "' + name + '" missing export ' + info.className)
    }

    return new Ctor(context.constructorOpts || {})
  }

  /**
   * Load a plugin from a file path.
   * Expects the module to have a default export (class or factory).
   */
  async _loadFromPath (modulePath, options = {}) {
    if (typeof modulePath !== 'string') {
      throw new Error('PluginLoader: modulePath must be a string')
    }
    if (modulePath.includes('\0')) {
      throw new Error('PluginLoader: modulePath contains invalid characters')
    }
    if (modulePath === '__proto__' || modulePath === 'constructor' || modulePath === 'prototype') {
      throw new Error('PluginLoader: invalid modulePath')
    }
    if (modulePath.includes('..')) {
      throw new Error('PluginLoader: modulePath cannot contain ".."')
    }

    let resolved = modulePath
    if (!modulePath.startsWith('file://')) {
      if (modulePath.startsWith('/')) {
        const cwd = process.cwd()
        if (!modulePath.startsWith(cwd)) {
          throw new Error('PluginLoader: absolute paths outside of working directory are not allowed')
        }
        resolved = pathToFileURL(modulePath).href
      } else {
        resolved = pathToFileURL(join(process.cwd(), modulePath)).href
      }
    }

    const mod = await import(resolved)
    const Ctor = mod.default
    if (!Ctor) {
      throw new Error('PluginLoader: module at "' + modulePath + '" has no default export')
    }

    if (typeof Ctor === 'function') {
      return new Ctor(options)
    }

    // If it's already an instance, return as-is
    return Ctor
  }

  /**
   * Validate that a provider conforms to the ServiceProvider interface.
   * Must have manifest(), start(), stop() methods.
   * manifest() must return an object with name and version.
   */
  validate (provider) {
    if (typeof provider.manifest !== 'function') {
      throw new Error('PluginLoader: provider missing manifest() method')
    }
    if (typeof provider.start !== 'function') {
      throw new Error('PluginLoader: provider missing start() method')
    }
    if (typeof provider.stop !== 'function') {
      throw new Error('PluginLoader: provider missing stop() method')
    }

    const m = provider.manifest()
    if (!m || typeof m.name !== 'string' || !m.name) {
      throw new Error('PluginLoader: manifest() must return { name: string, version: string }')
    }
    if (typeof m.version !== 'string' || !m.version) {
      throw new Error('PluginLoader: manifest().version must be a non-empty string')
    }
  }

  /**
   * Stop all loaded plugins in reverse order.
   */
  async stopAll () {
    const reversed = this.plugins.slice().reverse()
    for (const provider of reversed) {
      await provider.stop()
    }
    this.plugins = []
  }
}
