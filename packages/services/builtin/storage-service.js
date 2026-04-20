/**
 * Storage Service
 *
 * Provides Hyperdrive and Hypercore storage operations.
 * Apps use this to create, list, read, and write drives
 * without managing low-level Hypercore details.
 *
 * Capabilities:
 *   - drive-create: Create a new Hyperdrive
 *   - drive-list: List all drives
 *   - drive-get: Get drive info
 *   - drive-read: Read a file from a drive
 *   - drive-write: Write a file to a drive
 *   - drive-delete: Delete a file from a drive
 *   - core-create: Create a raw Hypercore
 *   - core-append: Append blocks to a core
 *   - core-get: Read blocks from a core
 */

import { ServiceProvider } from 'p2p-hiverelay/core/services/provider.js'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'

export class StorageService extends ServiceProvider {
  constructor (opts = {}) {
    super()
    this.store = null
    this.drives = new Map() // keyHex -> Hyperdrive
    this._driveOwners = new Map() // keyHex -> callerKey
    this.maxDrives = 256
    this.maxWriteBytes = opts.maxWriteBytes || 10 * 1024 * 1024
    this.policyGuard = opts.policyGuard || null
    this.getAppTier = opts.getAppTier || null // fn(keyHex) → tier string
  }

  manifest () {
    return {
      name: 'storage',
      version: '1.0.0',
      description: 'Hyperdrive and Hypercore storage operations',
      capabilities: [
        'drive-create', 'drive-list', 'drive-get',
        'drive-read', 'drive-write', 'drive-delete',
        'core-create', 'core-append', 'core-get'
      ]
    }
  }

  async start (context) {
    this.store = context.store
  }

  async stop () {
    for (const [, drive] of this.drives) {
      try { await drive.close() } catch {}
    }
    this.drives.clear()
  }

  async 'drive-create' (params, context = {}) {
    if (this.drives.size >= this.maxDrives) {
      throw new Error('DRIVE_LIMIT: max drives reached')
    }

    const drive = new Hyperdrive(this.store, params.key ? b4a.from(params.key, 'hex') : undefined)
    await drive.ready()

    const keyHex = b4a.toString(drive.key, 'hex')
    const callerKey = this._callerKey(context)
    this.drives.set(keyHex, drive)
    this._driveOwners.set(keyHex, callerKey)

    return {
      key: keyHex,
      discoveryKey: b4a.toString(drive.discoveryKey, 'hex'),
      writable: drive.writable,
      version: drive.version
    }
  }

  async 'drive-list' () {
    const list = []
    for (const [key, drive] of this.drives) {
      list.push({
        key,
        writable: drive.writable,
        version: drive.version
      })
    }
    return list
  }

  async 'drive-get' (params) {
    const drive = this._getDrive(params.key)
    return {
      key: params.key,
      writable: drive.writable,
      version: drive.version
    }
  }

  async 'drive-read' (params, context = {}) {
    this._checkPolicy(params.key, 'read-from-relay', context)
    const drive = this._getDrive(params.key)
    const data = await drive.get(params.path)
    if (!data) throw new Error('FILE_NOT_FOUND: ' + params.path)
    return { path: params.path, data: b4a.toString(data, 'base64'), size: data.length }
  }

  async 'drive-write' (params, context = {}) {
    this._checkPolicy(params.key, 'store-on-relay', context)
    this._assertDriveOwner(params.key, context)
    if (params.data && Buffer.byteLength(String(params.data)) > this.maxWriteBytes) {
      throw new Error('WRITE_TOO_LARGE: max write size exceeded')
    }
    const drive = this._getDrive(params.key)
    if (!drive.writable) throw new Error('DRIVE_READONLY')
    const data = b4a.from(params.data, params.encoding || 'base64')
    await drive.put(params.path, data)
    return { path: params.path, size: data.length }
  }

  async 'drive-delete' (params, context = {}) {
    this._checkPolicy(params.key, 'delete-from-relay', context)
    this._assertDriveOwner(params.key, context)
    const drive = this._getDrive(params.key)
    if (!drive.writable) throw new Error('DRIVE_READONLY')
    await drive.del(params.path)
    return { path: params.path, deleted: true }
  }

  async 'core-create' (params) {
    const core = this.store.get({ name: params.name || undefined })
    await core.ready()
    return {
      key: b4a.toString(core.key, 'hex'),
      writable: core.writable,
      length: core.length
    }
  }

  async 'core-append' (params, context = {}) {
    this._checkPolicy(params.key, 'store-on-relay', context)
    const core = this.store.get(b4a.from(params.key, 'hex'))
    await core.ready()
    if (!core.writable) throw new Error('CORE_READONLY')
    const blocks = params.blocks.map(b => b4a.from(b, params.encoding || 'base64'))
    await core.append(blocks)
    return { length: core.length }
  }

  async 'core-get' (params) {
    const core = this.store.get(b4a.from(params.key, 'hex'))
    await core.ready()
    const block = await core.get(params.index)
    if (!block) throw new Error('BLOCK_NOT_FOUND')
    return { index: params.index, data: b4a.toString(block, 'base64') }
  }

  _checkPolicy (keyHex, operation, context = {}) {
    if (!this.policyGuard || !this.getAppTier) return
    const tier = this.getAppTier(keyHex)
    if (!tier) {
      if (this._isAdminContext(context)) return
      throw new Error('ACCESS_DENIED: unknown content - policy check failed')
    }
    const check = this.policyGuard.check(keyHex, tier, operation)
    if (!check.allowed) {
      throw new Error(`POLICY_VIOLATION: ${check.reason}`)
    }
  }

  _assertDriveOwner (keyHex, context = {}) {
    if (this._isAdminContext(context)) return
    const owner = this._driveOwners.get(keyHex)
    if (!owner) return // drive not tracked (e.g. pre-existing)
    const caller = this._callerKey(context)
    if (caller !== owner) {
      throw new Error('ACCESS_DENIED: drive owned by another caller')
    }
  }

  _callerKey (context = {}) {
    if (context.remotePubkey) return context.remotePubkey
    if (context.userId) return context.userId
    if (context.caller === 'local' || context.role === 'local') return 'local'
    return 'anonymous'
  }

  _isAdminContext (context) {
    if (!context) return false
    return context.role === 'relay-admin' || context.role === 'local' || context.caller === 'local'
  }

  _getDrive (keyHex) {
    const drive = this.drives.get(keyHex)
    if (!drive) throw new Error('DRIVE_NOT_FOUND: ' + keyHex)
    return drive
  }
}
