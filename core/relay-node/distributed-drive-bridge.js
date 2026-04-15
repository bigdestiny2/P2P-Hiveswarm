import { EventEmitter } from 'events'

export class DistributedDriveBridge extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.enabled = opts.enabled !== false
    this.running = false
    this.moduleAvailable = false
    this.drive = null
    this._registered = new Map() // appKey -> drive
    this._peers = new Map() // conn -> peer session
    this.lastError = null
  }

  async start () {
    if (!this.enabled || this.running) return this.getStats()

    let DistributedDrive
    try {
      const mod = await import('distributed-drive')
      DistributedDrive = mod.default || mod.DistributedDrive || mod
    } catch (err) {
      this.lastError = err
      this.moduleAvailable = false
      this.emit('warning', {
        code: 'DISTRIBUTED_DRIVE_UNAVAILABLE',
        message: 'distributed-drive dependency not available',
        error: err.message
      })
      return this.getStats()
    }

    try {
      this.drive = new DistributedDrive()
      this.moduleAvailable = true
      this.running = true
      this.lastError = null
      this.emit('started', this.getStats())
    } catch (err) {
      this.lastError = err
      this.moduleAvailable = false
      this.running = false
      this.drive = null
      this.emit('warning', {
        code: 'DISTRIBUTED_DRIVE_INIT_FAILED',
        message: 'failed to initialize distributed-drive bridge',
        error: err.message
      })
    }

    return this.getStats()
  }

  registerDrive (appKey, drive) {
    if (!this.running || !this.drive || !drive || this._registered.has(appKey)) return false

    try {
      this.drive.register(drive)
      this._registered.set(appKey, drive)
      this.emit('drive-registered', { appKey })
      return true
    } catch (err) {
      this.lastError = err
      this.emit('warning', {
        code: 'DISTRIBUTED_DRIVE_REGISTER_FAILED',
        appKey,
        error: err.message
      })
      return false
    }
  }

  unregisterDrive (appKey) {
    const drive = this._registered.get(appKey)
    if (!drive) return false

    this._registered.delete(appKey)
    if (!this.running || !this.drive || typeof this.drive.unregister !== 'function') return true

    try {
      this.drive.unregister(drive)
    } catch (err) {
      this.lastError = err
      this.emit('warning', {
        code: 'DISTRIBUTED_DRIVE_UNREGISTER_FAILED',
        appKey,
        error: err.message
      })
      return false
    }

    this.emit('drive-unregistered', { appKey })
    return true
  }

  addPeer (conn, info = {}) {
    if (!this.running || !this.drive || this._peers.has(conn)) return null

    try {
      const peer = this.drive.addPeer(conn)
      this._peers.set(conn, peer)

      const cleanup = () => this._peers.delete(conn)
      if (typeof conn.once === 'function') conn.once('close', cleanup)
      else if (typeof conn.on === 'function') conn.on('close', cleanup)

      this.emit('peer-attached', { remotePubKey: info.remotePubKey || null })
      return peer
    } catch (err) {
      this.lastError = err
      this.emit('warning', {
        code: 'DISTRIBUTED_DRIVE_PEER_FAILED',
        remotePubKey: info.remotePubKey || null,
        error: err.message
      })
      return null
    }
  }

  async stop () {
    for (const appKey of this._registered.keys()) {
      this.unregisterDrive(appKey)
    }
    this._registered.clear()
    this._peers.clear()
    this.drive = null
    this.running = false
    this.emit('stopped', this.getStats())
    return this.getStats()
  }

  getStats () {
    return {
      enabled: this.enabled,
      running: this.running,
      moduleAvailable: this.moduleAvailable,
      registeredDrives: this._registered.size,
      peers: this._peers.size,
      lastError: this.lastError ? this.lastError.message : null
    }
  }
}
