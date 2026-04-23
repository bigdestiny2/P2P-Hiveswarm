/**
 * p2p-hiverelay — Pear/Bare runtime entry point.
 *
 * Launch with:
 *   pear run .                               (dev, from this directory)
 *   pear run -d pear://<key>                 (prod, after publish)
 *
 * Differences from the Node CLI:
 *   - Uses Pear.config.storage for persistence (app-scoped by Pear)
 *   - No HTTP server, no TUI, no Lightning, no vm sandbox
 *   - Auto-updates delivered via Pear's Hypercore-backed update mechanism
 *   - Lifecycle is managed by Pear (teardown on app exit, etc.)
 */

/* global Pear */

import { BareRelay } from './core/relay-node/bare-relay.js'
import b4a from 'b4a'

console.log()
console.log('  ╱═══════════════════════════════════════════════════════════════════╲')
console.log('      p2p-hiverelay  ·  pear/bare runtime  ·  always-on p2p relay')
console.log('  ╲═══════════════════════════════════════════════════════════════════╱')
console.log()
console.log('  [storage]', Pear.config.storage)
console.log()

const relay = new BareRelay({
  storage: Pear.config.storage,
  regions: parseRegions(Pear.config.args || []),
  maxStorageBytes: parseMaxStorage(Pear.config.args || []),
  httpPort: parsePort(Pear.config.args || []) || 9100
})

relay.on('started', ({ publicKey }) => {
  console.log()
  console.log('  ⬢ public key:', b4a.toString(publicKey, 'hex'))
  console.log()
})

await relay.start()

Pear.teardown(async () => {
  console.log()
  console.log('  [pear] teardown — stopping relay cleanly…')
  await relay.stop()
})

// Pear.updates is deprecated — prefer the dedicated pear-updates module.
// Wrap import in try/catch so older Pear versions without it still work.
try {
  const { default: updates } = await import('pear-updates')
  updates(() => {
    console.log('  [pear] update available — will apply on next restart')
  })
} catch (_) { /* pear-updates not available; skip */ }

// ─── Helpers ────────────────────────────────────────────────────────

function parseRegions (args) {
  const idx = args.indexOf('--region')
  if (idx >= 0 && args[idx + 1]) return [args[idx + 1]]
  return ['NA']
}

function parsePort (args) {
  const idx = args.indexOf('--port')
  if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1])
  return null
}

function parseMaxStorage (args) {
  const idx = args.indexOf('--max-storage')
  if (idx >= 0 && args[idx + 1]) return parseBytes(args[idx + 1])
  return 50 * 1024 * 1024 * 1024
}

function parseBytes (str) {
  const n = parseFloat(str)
  const s = String(str).toUpperCase()
  if (s.endsWith('TB')) return n * 1024 ** 4
  if (s.endsWith('GB')) return n * 1024 ** 3
  if (s.endsWith('MB')) return n * 1024 ** 2
  if (s.endsWith('KB')) return n * 1024
  return n
}
