/**
 * HiveRelay Stress / Load Test
 *
 * Creates 10 Hyperswarm instances simultaneously, all joining the
 * relay discovery topic, measures connection times, verifies concurrent
 * connections, checks relay status via HTTP, then tears down gracefully.
 */

import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'
import http from 'http'

// ── Config ────────────────────────────────────────────────────────────
const NUM_SWARMS = 10
const RELAY_API = 'http://127.0.0.1:9100'
const CONNECT_TIMEOUT_MS = 60_000 // per-swarm timeout waiting for first connection

// ── Discovery topic ──────────────────────────────────────────────────
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

// ── Helpers ──────────────────────────────────────────────────────────
function httpGet (url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(new Error('Bad JSON from relay API: ' + data)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(new Error('HTTP timeout')) })
  })
}

function fmt (ms) {
  return ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s'
}

// ── Main ─────────────────────────────────────────────────────────────
console.log('=== HiveRelay Stress Test ===')
console.log('Swarms:', NUM_SWARMS)
console.log('Topic:', b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex'))
console.log('')

// Step 0 — baseline relay status
let baselineConnections = 0
try {
  const before = await httpGet(`${RELAY_API}/status`)
  baselineConnections = before.connections ?? 0
  console.log(`[pre] Relay reports ${baselineConnections} existing connection(s)`)
} catch (e) {
  console.log(`[pre] Could not reach relay API (${e.message}) — will skip API checks`)
}

// Step 1 — Create all swarms, join topic, measure connection time
console.log(`\n[1/5] Creating ${NUM_SWARMS} swarms and joining topic...`)
const testStart = Date.now()

const swarms = []
const results = [] // { index, connected, timeMs, error, connections }

const tasks = Array.from({ length: NUM_SWARMS }, (_, i) => {
  return new Promise((resolve) => {
    const swarm = new Hyperswarm()
    swarms.push(swarm)

    const entry = { index: i, connected: false, timeMs: null, error: null, connections: 0 }
    results.push(entry)

    const start = Date.now()
    let resolved = false

    const finish = (err) => {
      if (resolved) return
      resolved = true
      entry.timeMs = Date.now() - start
      if (err) entry.error = err.message || String(err)
      entry.connections = swarm.connections.size
      resolve()
    }

    swarm.on('connection', (conn, info) => {
      entry.connections = swarm.connections.size
      if (!entry.connected) {
        entry.connected = true
        const pk = info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 12) : '?'
        console.log(`  swarm-${i}: first connection to ${pk}… in ${fmt(Date.now() - start)}`)
        finish()
      }
    })

    // Join as client+server
    const disc = swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: true })
    disc.flushed().catch(() => {}) // swallow flush errors

    swarm.flush().then(() => {
      // If no connection arrived by flush-time, give it more time via timeout
      if (!entry.connected) {
        console.log(`  swarm-${i}: flushed (no connection yet, waiting up to ${CONNECT_TIMEOUT_MS / 1000}s)...`)
      }
    }).catch((err) => {
      finish(err)
    })

    // Hard timeout per swarm
    setTimeout(() => {
      if (!resolved) {
        entry.connected = swarm.connections.size > 0
        entry.connections = swarm.connections.size
        finish(entry.connected ? null : new Error('timeout: no connection within ' + (CONNECT_TIMEOUT_MS / 1000) + 's'))
      }
    }, CONNECT_TIMEOUT_MS)
  })
})

await Promise.all(tasks)
const totalElapsed = Date.now() - testStart

// Step 2 — Summarise connection times
console.log('\n[2/5] Connection timing results:')

const connected = results.filter(r => r.connected)
const failed = results.filter(r => !r.connected)

for (const r of results) {
  const status = r.connected ? 'OK' : 'FAIL'
  const time = r.timeMs != null ? fmt(r.timeMs) : '-'
  const err = r.error ? ` (${r.error})` : ''
  console.log(`  swarm-${r.index}: ${status}  time=${time}  conns=${r.connections}${err}`)
}

// Step 3 — Aggregate stats
console.log('\n[3/5] Aggregate statistics:')
const times = connected.map(r => r.timeMs).filter(t => t != null)
const minT = times.length ? Math.min(...times) : 0
const maxT = times.length ? Math.max(...times) : 0
const avgT = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0
const totalConns = results.reduce((s, r) => s + r.connections, 0)

console.log(`  Connected:   ${connected.length} / ${NUM_SWARMS}`)
console.log(`  Failed:      ${failed.length} / ${NUM_SWARMS}`)
console.log(`  Min time:    ${fmt(minT)}`)
console.log(`  Max time:    ${fmt(maxT)}`)
console.log(`  Avg time:    ${fmt(avgT)}`)
console.log(`  Total conns across all swarms: ${totalConns}`)
console.log(`  Wall-clock:  ${fmt(totalElapsed)}`)

// Step 4 — Check relay API for its view of connections
console.log('\n[4/5] Relay API status check:')
try {
  const status = await httpGet(`${RELAY_API}/status`)
  console.log(`  Relay running:      ${status.running}`)
  console.log(`  Relay connections:  ${status.connections}`)
  console.log(`  Active circuits:    ${status.relay?.activeCircuits ?? '?'}`)
  console.log(`  Seeded apps:        ${status.seededApps ?? '?'}`)

  const peers = await httpGet(`${RELAY_API}/peers`)
  console.log(`  Peers endpoint:     ${peers.count} peer(s)`)
} catch (e) {
  console.log(`  Could not reach relay API: ${e.message}`)
}

// Step 5 — Graceful destroy
console.log('\n[5/5] Destroying all swarms...')
const destroyStart = Date.now()
await Promise.all(swarms.map(s => s.destroy().catch(() => {})))
console.log(`  All swarms destroyed in ${fmt(Date.now() - destroyStart)}`)

// ── Final relay status after cleanup ─────────────────────────────────
try {
  // Give the relay a moment to notice disconnections
  await new Promise(r => setTimeout(r, 2000))
  const after = await httpGet(`${RELAY_API}/status`)
  console.log(`  Relay connections after cleanup: ${after.connections}`)
} catch { /* ignore */ }

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n=== STRESS TEST COMPLETE ===')
console.log(`Result: ${failed.length === 0 ? 'PASS' : 'PARTIAL FAIL'} — ${connected.length}/${NUM_SWARMS} swarms connected`)
if (failed.length > 0) {
  console.log('Failed swarm indices:', failed.map(r => r.index).join(', '))
}

process.exit(failed.length === 0 ? 0 : 1)
