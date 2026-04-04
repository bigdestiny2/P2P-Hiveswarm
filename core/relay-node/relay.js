import { EventEmitter } from 'events'

const MAX_CIRCUIT_DURATION_MS = 10 * 60 * 1000 // 10 minutes default
const MAX_CIRCUIT_BYTES = 64 * 1024 * 1024 // 64 MB per circuit

function forward (from, to, circuit, circuitId, relay) {
  const canPause = typeof from.pause === 'function'
  const canResume = typeof from.resume === 'function'

  from.on('data', (chunk) => {
    if (circuit.bytesRelayed + chunk.byteLength > relay.maxCircuitBytes) {
      relay._closeCircuit(circuitId, 'BYTES_EXCEEDED')
      return
    }
    circuit.bytesRelayed += chunk.byteLength
    relay.totalBytesRelayed += chunk.byteLength
    if (!to.write(chunk) && canPause) from.pause()
  })

  if (typeof to.on === 'function' && canResume) {
    to.on('drain', () => from.resume())
  }
}

export class Relay extends EventEmitter {
  constructor (swarm, opts = {}) {
    super()
    this.swarm = swarm
    this.maxBandwidthMbps = opts.maxBandwidthMbps || 100
    this.maxConnections = opts.maxConnections || 256
    this.maxCircuitDuration = opts.maxCircuitDuration || MAX_CIRCUIT_DURATION_MS
    this.maxCircuitBytes = opts.maxCircuitBytes || MAX_CIRCUIT_BYTES

    // Active circuits: circuitId -> { source, dest, bytesRelayed, startedAt, timer, sourcePeerKey }
    this.circuits = new Map()
    // Per-peer circuit tracking: peer pubkey hex -> count
    this.circuitsPerPeer = new Map()
    this.maxCircuitsPerPeer = opts.maxCircuitsPerPeer || 5
    this.totalBytesRelayed = 0
    this.totalCircuitsServed = 0
    this.running = false
  }

  async start () {
    this.running = true
    this.emit('started')
  }

  /**
   * Create a relay circuit between two peers.
   * The relay forwards opaque encrypted bytes — it cannot read the content.
   *
   * @param {string} circuitId - Unique circuit identifier
   * @param {object} source - Source duplex stream (from requesting peer)
   * @param {object} dest - Destination duplex stream (to target peer)
   * @returns {object} Circuit info
   */
  createCircuit (circuitId, source, dest, sourcePeerKey) {
    if (this.circuits.size >= this.maxConnections) {
      throw new Error('RELAY_AT_CAPACITY')
    }

    if (sourcePeerKey) {
      const current = this.circuitsPerPeer.get(sourcePeerKey) || 0
      if (current >= this.maxCircuitsPerPeer) {
        throw new Error('PEER_AT_CAPACITY')
      }
      this.circuitsPerPeer.set(sourcePeerKey, current + 1)
    }

    const circuit = {
      id: circuitId,
      source,
      dest,
      sourcePeerKey: sourcePeerKey || null,
      bytesRelayed: 0,
      startedAt: Date.now(),
      timer: null
    }

    // Bidirectional forwarding with backpressure
    forward(source, dest, circuit, circuitId, this)
    forward(dest, source, circuit, circuitId, this)

    // Clean up on either side closing
    const onClose = () => this._closeCircuit(circuitId, 'PEER_CLOSED')
    source.on('close', onClose)
    source.on('error', onClose)
    dest.on('close', onClose)
    dest.on('error', onClose)

    // Max duration timer
    circuit.timer = setTimeout(() => {
      this._closeCircuit(circuitId, 'DURATION_EXCEEDED')
    }, this.maxCircuitDuration)

    this.circuits.set(circuitId, circuit)
    this.totalCircuitsServed++

    this.emit('circuit-created', {
      circuitId,
      maxBytes: this.maxCircuitBytes,
      maxDuration: this.maxCircuitDuration
    })

    return circuit
  }

  _closeCircuit (circuitId, reason = 'UNKNOWN') {
    const circuit = this.circuits.get(circuitId)
    if (!circuit) return

    // Cancel timer FIRST to prevent re-entrant calls
    if (circuit.timer) {
      clearTimeout(circuit.timer)
      circuit.timer = null
    }

    // Then remove from map
    this.circuits.delete(circuitId)

    // Decrement per-peer count
    if (circuit.sourcePeerKey) {
      const count = this.circuitsPerPeer.get(circuit.sourcePeerKey) || 0
      if (count <= 1) {
        this.circuitsPerPeer.delete(circuit.sourcePeerKey)
      } else {
        this.circuitsPerPeer.set(circuit.sourcePeerKey, count - 1)
      }
    }

    // Then clean up streams
    try { circuit.source.destroy() } catch {}
    try { circuit.dest.destroy() } catch {}

    this.emit('circuit-closed', {
      circuitId,
      reason,
      bytesRelayed: circuit.bytesRelayed,
      durationMs: Date.now() - circuit.startedAt
    })
  }

  getStats () {
    return {
      activeCircuits: this.circuits.size,
      totalCircuitsServed: this.totalCircuitsServed,
      totalBytesRelayed: this.totalBytesRelayed,
      capacityUsedPct: Math.round((this.circuits.size / this.maxConnections) * 100),
      peersWithCircuits: this.circuitsPerPeer.size
    }
  }

  async stop () {
    this.running = false
    for (const circuitId of [...this.circuits.keys()]) {
      this._closeCircuit(circuitId, 'SHUTDOWN')
    }
    this.circuitsPerPeer.clear()
    this.emit('stopped')
  }
}
