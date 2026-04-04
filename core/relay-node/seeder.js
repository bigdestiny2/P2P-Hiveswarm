import b4a from 'b4a'
import { EventEmitter } from 'events'

export class Seeder extends EventEmitter {
  constructor (store, swarm, opts = {}) {
    super()
    this.store = store
    this.swarm = swarm
    this.maxStorageBytes = opts.maxStorageBytes || 50 * 1024 * 1024 * 1024
    this.announceInterval = opts.announceInterval || 15 * 60 * 1000
    this.cores = new Map() // hex key -> { core, interval, bytesStored }
    this.totalBytesStored = 0
    this.totalBytesServed = 0
    this.running = false
  }

  async start () {
    this.running = true
    this.emit('started')
  }

  async seedCore (publicKeyHex) {
    if (this.cores.has(publicKeyHex)) return this.cores.get(publicKeyHex)

    const key = b4a.from(publicKeyHex, 'hex')
    const core = this.store.get({ key })
    await core.ready()

    // Download all blocks
    const range = core.download({ start: 0, end: -1 })

    // Periodically re-announce on the DHT
    const topic = core.discoveryKey
    this.swarm.join(topic, { server: true, client: true })

    const interval = setInterval(() => {
      if (this.running) {
        this.swarm.join(topic, { server: true, client: true })
      }
    }, this.announceInterval)

    const entry = {
      core,
      range,
      interval,
      topic,
      publicKeyHex,
      startedAt: Date.now(),
      bytesStored: 0,
      bytesServed: 0
    }

    // Track storage as blocks download
    core.on('download', (index, byteLength) => {
      entry.bytesStored += byteLength
      this.totalBytesStored += byteLength
      this.emit('block-downloaded', { publicKeyHex, index, byteLength })
    })

    core.on('upload', (index, byteLength) => {
      entry.bytesServed += byteLength
      this.totalBytesServed += byteLength
      this.emit('block-served', { publicKeyHex, index, byteLength })
    })

    this.cores.set(publicKeyHex, entry)
    this.emit('seeding-core', { publicKeyHex, length: core.length })

    return entry
  }

  async unseedCore (publicKeyHex) {
    const entry = this.cores.get(publicKeyHex)
    if (!entry) return

    clearInterval(entry.interval)
    await this.swarm.leave(entry.topic)
    entry.range.destroy()
    await entry.core.close()

    this.totalBytesStored -= entry.bytesStored
    this.cores.delete(publicKeyHex)

    this.emit('unseeded-core', { publicKeyHex })
  }

  hasCapacity (additionalBytes = 0) {
    return (this.totalBytesStored + additionalBytes) < this.maxStorageBytes
  }

  getStats () {
    return {
      coresSeeded: this.cores.size,
      totalBytesStored: this.totalBytesStored,
      totalBytesServed: this.totalBytesServed,
      capacityUsedPct: Math.round((this.totalBytesStored / this.maxStorageBytes) * 100)
    }
  }

  async stop () {
    this.running = false
    for (const key of this.cores.keys()) {
      await this.unseedCore(key)
    }
    this.emit('stopped')
  }
}
