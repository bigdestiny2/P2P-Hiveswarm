#!/usr/bin/env node

/**
 * Start HomeHive — Private Mode Relay
 * ====================================
 * Runs HiveRelay in private mode: no DHT, no public discovery,
 * devices must be explicitly paired to connect.
 *
 * Usage:
 *   node scripts/start-homehive.js
 *   node scripts/start-homehive.js --pair          # enable pairing for 5 minutes
 *   node scripts/start-homehive.js --add-device <pubkey> <name>
 */

import { RelayNode } from '../core/relay-node/index.js'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'

const STORAGE_DIR = process.env.HOMEHIVE_STORAGE || join(process.env.HOME || '.', '.homehive')
const API_PORT = parseInt(process.env.HOMEHIVE_PORT || '9100', 10)
const args = process.argv.slice(2)

mkdirSync(STORAGE_DIR, { recursive: true })

function getLocalIPs () {
  const ifaces = networkInterfaces()
  const result = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.internal) continue
      if (addr.family === 'IPv4' || addr.family === 4) {
        result.push({ interface: name, address: addr.address })
      }
    }
  }
  return result
}

async function main () {
  const localIPs = getLocalIPs()

  console.log('=================================================')
  console.log('  HomeHive — Private Relay')
  console.log('  Mode: private (LAN + WiFi, no public internet)')
  console.log(`  Storage: ${STORAGE_DIR}`)
  console.log('=================================================\n')

  console.log('  Network interfaces:')
  for (const ip of localIPs) {
    const isWifi = /^(wl|wi|en0|en1|wlan|Wi-Fi)/i.test(ip.interface)
    const label = isWifi ? '(wifi)' : '(wired)'
    console.log(`    ${ip.interface}: ${ip.address} ${label}`)
  }
  console.log()

  const node = new RelayNode({
    mode: 'private',
    storage: STORAGE_DIR,
    enableAPI: true,
    enableMetrics: true,
    apiPort: API_PORT,
    apiHost: '0.0.0.0', // Listen on all interfaces (LAN + wifi)
    discovery: {
      dht: false,
      announce: false,
      mdns: true,
      explicit: true
    },
    name: process.env.HOMEHIVE_NAME || 'homehive'
  })

  // Event logging
  node.on('started', ({ publicKey }) => {
    console.log(`  Public key: ${publicKey.toString('hex')}`)
    console.log(`  Paired devices: ${node.listDevices().length}`)
    console.log()

    console.log('  Reachable at:')
    for (const ip of localIPs) {
      console.log(`    http://${ip.address}:${API_PORT}/dashboard`)
    }
    console.log()

    if (node.listDevices().length === 0) {
      console.log('  No devices paired yet.')
      console.log('  Run with --pair to enable pairing mode.')
      console.log()
    }
  })

  node.on('device-paired', ({ pubkey, name }) => {
    console.log(`  + Device paired: ${name} (${pubkey.slice(0, 16)}...)`)
  })

  node.on('device-removed', ({ pubkey }) => {
    console.log(`  - Device removed: ${pubkey.slice(0, 16)}...`)
  })

  node.on('connection', ({ remotePubKey }) => {
    console.log(`  <- Device connected: ${remotePubKey.slice(0, 16)}...`)
  })

  node.on('connection-rejected', ({ remotePubKey, reason }) => {
    console.log(`  x Connection rejected: ${remotePubKey.slice(0, 16)}... (${reason})`)
  })

  node.on('connection-closed', () => {
    console.log('  -> Device disconnected')
  })

  node.on('pairing-success', ({ pubkey, name }) => {
    console.log(`  * Pairing successful: ${name} (${pubkey.slice(0, 16)}...)`)
  })

  node.on('pairing-rejected', ({ reason, pubkey }) => {
    console.log(`  x Pairing rejected: ${reason} (${pubkey ? pubkey.slice(0, 16) + '...' : 'unknown'})`)
  })

  node.on('lan-peer-discovered', ({ pubkey, host, port, name }) => {
    console.log(`  ~ LAN peer found: ${name} at ${host}:${port} (${pubkey.slice(0, 16)}...)`)
  })

  node.on('seeding', ({ appKey }) => {
    console.log(`  > Serving app: ${appKey.slice(0, 16)}...`)
  })

  await node.start()

  // Handle --pair flag
  if (args.includes('--pair')) {
    const timeoutMs = 5 * 60 * 1000
    const info = node.enablePairing({ timeoutMs })
    console.log('  PAIRING MODE ACTIVE (5 minutes)')
    console.log('  ─────────────────────────────────')
    console.log(`  Token: ${info.token}`)
    console.log(`  Relay pubkey: ${info.relayPubkey}`)
    console.log()
    console.log('  Reachable from any device on this network:')
    for (const ip of localIPs) {
      const isWifi = /^(wl|wi|en0|en1|wlan|Wi-Fi)/i.test(ip.interface)
      console.log(`    ${ip.address}:${API_PORT} ${isWifi ? '(wifi)' : '(wired)'}`)
    }
    console.log()
    console.log('  Share this with the device to pair:')
    const pairingPayload = {
      pubkey: info.relayPubkey,
      token: info.token,
      addresses: localIPs.map(ip => `${ip.address}:${API_PORT}`)
    }
    console.log(`  ${JSON.stringify(pairingPayload)}`)
    console.log()
  }

  // Handle --add-device flag
  const addIdx = args.indexOf('--add-device')
  if (addIdx !== -1) {
    const pubkey = args[addIdx + 1]
    const name = args[addIdx + 2] || 'manual'
    if (!pubkey || pubkey.length !== 64) {
      console.error('  Error: --add-device requires a 64-char hex pubkey')
      process.exit(1)
    }
    await node.addDevice(pubkey, name)
    console.log(`  Added device: ${name} (${pubkey.slice(0, 16)}...)`)
    console.log()
  }

  // List paired devices
  const devices = node.listDevices()
  if (devices.length > 0) {
    console.log('  Paired devices:')
    for (const d of devices) {
      console.log(`    ${d.name}: ${d.pubkey.slice(0, 16)}... (paired ${new Date(d.pairedAt).toLocaleDateString()})`)
    }
    console.log()
  }

  console.log('  HomeHive running. Press Ctrl+C to stop.\n')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n  Shutting down HomeHive...')
    await node.stop()
    console.log('  Done.')
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
