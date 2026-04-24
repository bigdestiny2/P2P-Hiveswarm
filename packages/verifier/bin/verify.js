#!/usr/bin/env node

/**
 * hive-verify — CLI for the cross-client verifier.
 *
 * Examples:
 *   hive-verify https://relay-a.example.com https://relay-b.example.com
 *     → compares capability docs + catalogs across both relays
 *
 *   hive-verify --drive abc123... https://relay-a https://relay-b https://relay-c
 *     → compares the three relays' views of a specific drive
 *
 *   hive-verify --json ...
 *     → emit raw JSON report instead of human-readable
 *
 * Exit codes:
 *   0  — all relays agree (or insufficient data — better report that
 *        than silently pass a single-source check)
 *   1  — divergence detected (the important case)
 *   2  — all relays failed to respond
 *   3  — argument or usage error
 */

import { verifyRelays, compareDrive } from '../index.js'

function usage () {
  console.error('Usage:')
  console.error('  hive-verify <relay-url-1> <relay-url-2> [<relay-url-3> ...]')
  console.error('  hive-verify --drive <drive-key-hex> <relay-url-1> <relay-url-2> [...]')
  console.error('')
  console.error('Options:')
  console.error('  --json        emit raw JSON instead of human-readable')
  console.error('  --timeout N   per-fetch timeout in ms (default 10000)')
  console.error('  --help        show this message')
}

async function main () {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.length === 0) {
    usage()
    process.exit(args.length === 0 ? 3 : 0)
  }

  const jsonMode = args.includes('--json')
  let driveKey = null
  let timeoutMs = 10_000
  const relayUrls = []

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--json') continue
    if (a === '--drive') {
      driveKey = args[++i]
      if (!driveKey) { usage(); process.exit(3) }
      continue
    }
    if (a === '--timeout') {
      timeoutMs = parseInt(args[++i]) || 10_000
      continue
    }
    if (a.startsWith('--')) {
      console.error('Unknown option: ' + a)
      usage()
      process.exit(3)
    }
    relayUrls.push(a)
  }

  if (relayUrls.length < 2) {
    console.error('Error: need at least 2 relay URLs to compare.')
    usage()
    process.exit(3)
  }

  try {
    if (driveKey) {
      const report = await compareDrive(driveKey, relayUrls, { timeoutMs })
      if (jsonMode) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        printDriveReport(report)
      }
      process.exit(report.agreement === 'agree' ? 0 : 1)
    } else {
      const report = await verifyRelays(relayUrls, { timeoutMs })
      if (jsonMode) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        printRelayReport(report)
      }
      if (report.fetchErrors.length === relayUrls.length * 2) {
        process.exit(2) // everything failed
      }
      process.exit(report.verdict === 'agree' ? 0 : 1)
    }
  } catch (err) {
    console.error('Error: ' + err.message)
    process.exit(3)
  }
}

function printRelayReport (r) {
  console.log('Relays checked:')
  for (const url of r.checkedRelays) console.log('  ' + url)
  console.log('')
  console.log('Capabilities OK: ' + (r.capabilitiesOK ? '✓' : '✗ (see errors below)'))
  console.log('Catalogs OK:     ' + (r.catalogsOK ? '✓' : '✗ (see errors below)'))
  console.log('')
  if (r.fetchErrors.length > 0) {
    console.log('Fetch errors:')
    for (const e of r.fetchErrors) {
      console.log('  ' + e.relay + ' (' + e.endpoint + '): ' + e.error)
    }
    console.log('')
  }
  console.log('Divergences: ' + r.divergenceCount)
  for (const d of r.divergences) {
    if (d.category === 'capability') {
      console.log('  [capability] ' + d.field + ' differs between ' + d.relayA + ' and ' + d.relayB)
      console.log('    A: ' + JSON.stringify(d.valueA))
      console.log('    B: ' + JSON.stringify(d.valueB))
    } else if (d.category === 'catalog-entry') {
      console.log('  [catalog] ' + d.appKey + ' differs on: ' + d.divergentFields.join(', '))
      console.log('    A (' + d.relayA + '): ' + JSON.stringify(d.entryA))
      console.log('    B (' + d.relayB + '): ' + JSON.stringify(d.entryB))
    }
  }
  console.log('')
  console.log('Verdict: ' + r.verdict.toUpperCase())
}

function printDriveReport (r) {
  console.log('Drive: ' + r.drive)
  console.log('')
  console.log('Views:')
  for (const v of r.views) {
    if (v.ok) {
      console.log('  ' + v.relay + ' → length=' + (v.info?.length ?? '?') + ' version=' + (v.info?.version ?? '?'))
    } else {
      console.log('  ' + v.relay + ' → ERROR: ' + v.error)
    }
  }
  console.log('')
  if (r.agreement === 'insufficient-data') {
    console.log('Verdict: INSUFFICIENT DATA (need at least 2 successful responses)')
  } else if (r.agreement === 'agree') {
    console.log('Verdict: AGREE (all responding relays serve the same drive state)')
  } else {
    console.log('Verdict: DIVERGE')
    for (const d of r.divergentFrom) {
      console.log('  ' + d.relay + ' disagrees with ' + d.vs + ' on: ' + d.fields.join(', '))
    }
  }
}

main().catch(err => {
  console.error('Unexpected error: ' + err.stack)
  process.exit(3)
})
