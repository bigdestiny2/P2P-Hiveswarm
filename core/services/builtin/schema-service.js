/**
 * Schema Registry Service
 *
 * Registers, stores, and validates JSON Schema definitions for cross-app
 * data interoperability. Apps publish schemas so other apps can deserialize
 * and consume shared data formats without sharing code.
 *
 * Storage: In-memory Map with optional persistence to seeding registry log.
 * Validation: Inline lightweight JSON Schema validator (no external deps).
 */

import { ServiceProvider } from '../provider.js'

export class SchemaService extends ServiceProvider {
  constructor () {
    super()
    this.schemas = new Map() // schemaId -> [{ schemaId, version, definition, ... }]
    this.node = null
  }

  manifest () {
    return {
      name: 'schema',
      version: '1.0.0',
      description: 'JSON Schema registration and validation for cross-app data interoperability',
      capabilities: ['register', 'get', 'list', 'validate', 'versions']
    }
  }

  async start (context) {
    this.node = context.node
  }

  async stop () {
    this.schemas.clear()
  }

  /**
   * Register a new schema version.
   * @param {object} params - { schemaId, version, definition, description? }
   */
  async register (params, context) {
    if (!params.schemaId || typeof params.schemaId !== 'string') {
      throw new Error('SCHEMA_MISSING_ID')
    }
    if (!params.version || typeof params.version !== 'string') {
      throw new Error('SCHEMA_MISSING_VERSION')
    }
    if (!params.definition || typeof params.definition !== 'object') {
      throw new Error('SCHEMA_MISSING_DEFINITION')
    }
    if (params.schemaId.length > 128) throw new Error('SCHEMA_ID_TOO_LONG')

    // Enforce size limit on schema definitions (64KB max)
    if (JSON.stringify(params.definition).length > 65536) {
      throw new Error('SCHEMA_DEFINITION_TOO_LARGE')
    }

    const versions = this.schemas.get(params.schemaId) || []

    // Check for duplicate version
    if (versions.some(v => v.version === params.version)) {
      throw new Error('SCHEMA_VERSION_EXISTS')
    }

    // Ownership check: if schema already exists, only original publisher can add versions
    if (versions.length > 0) {
      const originalPublisher = versions[0].publisherPubkey
      const caller = context?.remotePubkey || 'local'
      if (originalPublisher !== 'local' && caller !== originalPublisher) {
        throw new Error('SCHEMA_UNAUTHORIZED: only the original publisher can add versions')
      }
    }

    const entry = {
      schemaId: params.schemaId,
      version: params.version,
      definition: params.definition,
      publisherPubkey: context?.remotePubkey || 'local',
      registeredAt: Date.now(),
      description: params.description || ''
    }

    versions.push(entry)
    this.schemas.set(params.schemaId, versions)

    // Optional: persist to seeding registry log
    if (this.node?.seedingRegistry?.localLog) {
      try {
        const logEntry = { type: 'schema-register', ...entry }
        const b4a = await import('b4a')
        await this.node.seedingRegistry.localLog.append(
          b4a.default.from(JSON.stringify(logEntry))
        )
      } catch {}
    }

    return entry
  }

  /**
   * Get a schema by ID (latest version or specific version).
   * @param {object} params - { schemaId, version? }
   */
  async get (params) {
    if (!params.schemaId) throw new Error('SCHEMA_MISSING_ID')

    const versions = this.schemas.get(params.schemaId)
    if (!versions || versions.length === 0) throw new Error('SCHEMA_NOT_FOUND')

    if (params.version) {
      const entry = versions.find(v => v.version === params.version)
      if (!entry) throw new Error('SCHEMA_VERSION_NOT_FOUND')
      return entry
    }

    // Return latest (last registered)
    return versions[versions.length - 1]
  }

  /**
   * List all schemas (latest version of each).
   */
  async list () {
    const result = []
    for (const [, versions] of this.schemas) {
      result.push(versions[versions.length - 1])
    }
    return result
  }

  /**
   * Validate data against a registered schema.
   * @param {object} params - { schemaId, data, version? }
   */
  async validate (params) {
    if (!params.schemaId) throw new Error('SCHEMA_MISSING_ID')
    if (params.data === undefined) throw new Error('SCHEMA_MISSING_DATA')

    const entry = await this.get({ schemaId: params.schemaId, version: params.version })
    const errors = this._validate(params.data, entry.definition, '')

    return { valid: errors.length === 0, errors }
  }

  /**
   * Get all versions for a schema.
   * @param {object} params - { schemaId }
   */
  async versions (params) {
    if (!params.schemaId) throw new Error('SCHEMA_MISSING_ID')

    const versions = this.schemas.get(params.schemaId)
    if (!versions) throw new Error('SCHEMA_NOT_FOUND')

    return versions.map(v => ({
      version: v.version,
      registeredAt: v.registeredAt,
      publisherPubkey: v.publisherPubkey,
      description: v.description
    }))
  }

  // --- Inline JSON Schema validator ---

  _validate (data, schema, path) {
    const errors = []
    if (!schema || typeof schema !== 'object') return errors

    // Type check
    if (schema.type) {
      const actual = Array.isArray(data) ? 'array' : (data === null ? 'null' : typeof data)
      if (schema.type === 'integer') {
        if (typeof data !== 'number' || !Number.isInteger(data)) {
          errors.push(`${path || '/'}: expected integer, got ${actual}`)
        }
      } else if (actual !== schema.type) {
        errors.push(`${path || '/'}: expected ${schema.type}, got ${actual}`)
      }
    }

    // Required fields
    if (schema.required && Array.isArray(schema.required) && typeof data === 'object' && data !== null) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`${path || '/'}/${field}: required field missing`)
        }
      }
    }

    // Properties (recursive)
    if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          errors.push(...this._validate(data[key], propSchema, `${path}/${key}`))
        }
      }
    }

    // Numeric constraints
    if (typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) {
        errors.push(`${path || '/'}: ${data} < minimum ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && data > schema.maximum) {
        errors.push(`${path || '/'}: ${data} > maximum ${schema.maximum}`)
      }
    }

    // String constraints
    if (typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) {
        errors.push(`${path || '/'}: length ${data.length} < minLength ${schema.minLength}`)
      }
      if (schema.maxLength !== undefined && data.length > schema.maxLength) {
        errors.push(`${path || '/'}: length ${data.length} > maxLength ${schema.maxLength}`)
      }
    }

    // Enum
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.includes(data)) {
        errors.push(`${path || '/'}: value not in enum [${schema.enum.join(', ')}]`)
      }
    }

    // Array items
    if (schema.items && Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...this._validate(data[i], schema.items, `${path}[${i}]`))
      }
    }

    return errors
  }
}
