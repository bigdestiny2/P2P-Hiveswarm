/**
 * PluginLoader — Config-driven plugin architecture for services
 *
 * Loads service providers from config instead of hardcoding imports.
 * Supports builtin services by name and external plugins by path.
 *
 * Config examples:
 *   plugins: ['storage', 'identity', 'compute']        // builtins by name
 *   plugins: ['./my-plugin.js']                         // path to module
 *   plugins: [{ path: './my-plugin.js', options: {} }]  // with options
 */

import { join } from 'path'
import { pathToFileURL } from 'url'

const BUILTIN_MAP = {
  storage: { file: 'storage-service.js', className: 'StorageService' },
  identity: { file: 'identity-service.js', className: 'IdentityService' },
  compute: { file: 'compute-service.js', className: 'ComputeService' },
  ai: { file: 'ai-service.js', className: 'AIService' },
  zk: { file: 'zk-service.js', className: 'ZKService' },
  sla: { file: 'sla-service.js', className: 'SLAService' },
  schema: { file: 'schema-service.js', className: 'SchemaService' },
  arbitration: { file: 'arbitration-service.js', className: 'ArbitrationService' }
}

export class PluginLoader {
  constructor (opts = {}) {
    this.plugins = []
    this._builtinDir = opts.builtinDir || null
  }

  /**
   * Load plugins from a config array.
   * Each entry can be:
   *   - A string name matching a builtin (e.g. 'ai', 'compute', 'storage')
   *   - A string path (relative or absolute) to a module with a default export
   *   - An object { path, options } for plugins needing config
   */
  async load (pluginConfigs, context = {}) {
    const providers = []

    for (const entry of pluginConfigs) {
      let provider

      if (typeof entry === 'string') {
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
   * Load a single builtin service by name.
   * @param {string} name - One of: storage, identity, compute, ai, zk, sla, schema, arbitration
   * @param {object} context - Optional context passed to constructors that need it
   * @returns {object} Instantiated service provider
   */
  async loadBuiltin (name, context = {}) {
    const info = BUILTIN_MAP[name]
    if (!info) {
      throw new Error('PluginLoader: unknown builtin "' + name + '"')
    }

    const builtinDir = this._builtinDir || new URL('./services/builtin/', import.meta.url).pathname
    const fullPath = join(builtinDir, info.file)
    const fileUrl = pathToFileURL(fullPath).href
    const mod = await import(fileUrl)
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
    let resolved = modulePath
    if (!modulePath.startsWith('file://')) {
      if (modulePath.startsWith('/')) {
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
