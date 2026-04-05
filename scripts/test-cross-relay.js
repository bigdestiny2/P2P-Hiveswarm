#!/usr/bin/env node

/**
 * Cross-Relay Discovery & Stability Test
 *
 * Joins the hiverelay-discovery-v1 topic via Hyperswarm, discovers
 * the local relay (f1b82032...) and Cloudzy relay (6d905b17...),
 * then verifies both connections remain stable for 15 seconds.
 */

import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import sodium from 'sodium-universal'

// --- Config ---
const KNOWN_RELAYS = {
  local:   { pkPrefix: 'f1b82032', label: 'Local   (127.0.0.1:9100)' },
  cloudzy: { pkPrefix: '6d905b17', label: 'Cloudzy (REDACTED_SERVER_IP:9100)' }
}
const DISCOVERY_TIMEOUT_MS = 45_000
const STABILITY_WINDOW_MS  = 15_000

// --- Derive topic ---
const RELAY_DISCOVERY_TOPIC = b4a.alloc(32)
sodium.crypto_generichash(RELAY_DISCOVERY_TOPIC, b4a.from('hiverelay-discovery-v1'))

// --- State ---
const startTime = Date.now()
const discovered = new Map()          // pkHex -> { label, time, conn, disconnected }
const allConnections = []              // every connection we see
let stabilityTimer = null
let discoveryTimer = null

function elapsed () { return ((Date.now() - startTime) / 1000).toFixed(2) }

function identifyRelay (pkHex) {
  for (const [id, { pkPrefix, label }] of Object.entries(KNOWN_RELAYS)) {
    if (pkHex.startsWith(pkPrefix)) return { id, label }
  }
  return null
}

function allRelaysFound () {
  return Object.keys(KNOWN_RELAYS).every(id =>
    [...discovered.values()].some(d => d.id === id)
  )
}

// --- Report ---
function report (stabilityOk) {
  console.log('\n========== CROSS-RELAY TEST REPORT ==========')
  console.log(`Topic: ${b4a.toString(RELAY_DISCOVERY_TOPIC, 'hex')}`)
  console.log(`Total connections seen: ${allConnections.length}`)
  console.log('')

  for (const [id, { pkPrefix, label }] of Object.entries(KNOWN_RELAYS)) {
    const entry = [...discovered.values()].find(d => d.id === id)
    if (entry) {
      const disc = ((entry.time - startTime) / 1000).toFixed(2)
      const status = entry.disconnected ? 'DISCONNECTED' : 'CONNECTED'
      console.log(`  [FOUND]  ${label}`)
      console.log(`           PK prefix : ${pkPrefix}...`)
      console.log(`           Discovered: ${disc}s after start`)
      console.log(`           Status    : ${status}`)
    } else {
      console.log(`  [MISS]   ${label}  -- NOT discovered within ${DISCOVERY_TIMEOUT_MS / 1000}s`)
    }
  }

  // Unidentified peers
  const unidentified = allConnections.filter(c => !identifyRelay(c.pkHex))
  if (unidentified.length) {
    console.log(`\n  Unidentified peers: ${unidentified.length}`)
    for (const u of unidentified) {
      console.log(`    PK: ${u.pkHex.slice(0, 16)}...`)
    }
  }

  console.log('')
  const bothFound = allRelaysFound()
  console.log(`Both relays discovered : ${bothFound ? 'YES' : 'NO'}`)
  console.log(`Connection stability   : ${stabilityOk ? 'PASS (15s no disconnects)' : 'FAIL or SKIPPED'}`)
  console.log('==============================================')

  if (bothFound && stabilityOk) {
    console.log('\nRESULT: ALL CHECKS PASSED')
  } else {
    console.log('\nRESULT: SOME CHECKS FAILED')
  }
}

// --- Main ---
const swarm = new Hyperswarm()
console.log(`[${elapsed()}s] Hyperswarm created, joining discovery topic...`)

swarm.on('connection', (conn, info) => {
  const pkHex = info.publicKey ? b4a.toString(info.publicKey, 'hex') : ''
  const short = pkHex.slice(0, 16)
  console.log(`[${elapsed()}s] Connection from PK: ${short}...`)

  allConnections.push({ pkHex, time: Date.now(), conn })

  const match = identifyRelay(pkHex)
  if (match && !discovered.has(pkHex)) {
    discovered.set(pkHex, {
      id: match.id,
      label: match.label,
      time: Date.now(),
      conn,
      disconnected: false
    })
    console.log(`[${elapsed()}s]   -> Identified as ${match.label}`)

    if (allRelaysFound()) {
      console.log(`[${elapsed()}s] Both relays discovered! Starting ${STABILITY_WINDOW_MS / 1000}s stability window...`)
      clearTimeout(discoveryTimer)
      startStabilityCheck()
    }
  }

  conn.on('error', () => {})  // swallow to avoid crash

  conn.on('close', () => {
    console.log(`[${elapsed()}s] Disconnected: ${short}...`)
    const entry = discovered.get(pkHex)
    if (entry) entry.disconnected = true
  })
})

// Join the discovery topic (client-only so we find existing servers)
const discovery = swarm.join(RELAY_DISCOVERY_TOPIC, { server: false, client: true })
await discovery.flushed()
console.log(`[${elapsed()}s] Topic flushed. Own PK: ${b4a.toString(swarm.keyPair.publicKey, 'hex').slice(0, 16)}...`)
console.log(`[${elapsed()}s] Waiting up to ${DISCOVERY_TIMEOUT_MS / 1000}s for relay connections...\n`)

// Discovery timeout
discoveryTimer = setTimeout(async () => {
  if (!allRelaysFound()) {
    console.log(`\n[${elapsed()}s] Discovery timeout reached.`)
    report(false)
    await swarm.destroy()
    process.exit(1)
  }
}, DISCOVERY_TIMEOUT_MS)

function startStabilityCheck () {
  if (stabilityTimer) return
  stabilityTimer = setTimeout(async () => {
    // Check that no known relay disconnected during the window
    const allStable = [...discovered.values()].every(d => !d.disconnected)
    report(allStable)
    await swarm.destroy()
    process.exit(allStable ? 0 : 1)
  }, STABILITY_WINDOW_MS)
}
