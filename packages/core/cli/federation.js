/**
 * HiveRelay CLI — `federation` subcommand surface.
 *
 * Operator-facing wrappers around the relay's /api/manage/federation/*
 * HTTP endpoints. Pure helpers + a top-level dispatcher; no side effects
 * on import.
 */

import {
  resolveApiUrl, resolveApiKey, performRequest, isValidHexKey
} from './catalog.js'

export const FEDERATION_HELP = `Usage:
  hiverelay federation list
  hiverelay federation follow <url> [--pubkey <hex>]
  hiverelay federation mirror <url> [--pubkey <hex>]
  hiverelay federation unfollow <url>
  hiverelay federation republish <appKey> --source <url> [--channel <name>] [--note <text>]
  hiverelay federation unrepublish <appKey>

Options:
  --api-url <url>      Relay API base URL (default: http://127.0.0.1:9100)
  --api-key <key>      API key (or use HIVERELAY_API_KEY env)
`

export function isValidUrl (value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  return v.startsWith('http://') || v.startsWith('https://')
}

/**
 * Build the HTTP request descriptor for a given federation subcommand.
 * Throws Error on validation failure.
 */
export function buildFederationRequest (subcommand, positional, argv = {}) {
  switch (subcommand) {
    case 'list': {
      return { method: 'GET', path: '/api/manage/federation', body: null }
    }
    case 'follow':
    case 'mirror': {
      const url = positional[0]
      if (!isValidUrl(url)) throw new Error('url must start with http:// or https://')
      const body = { url: url.trim() }
      if (argv.pubkey !== undefined) {
        if (!isValidHexKey(String(argv.pubkey), 64)) {
          throw new Error('--pubkey must be 64 hex characters')
        }
        body.pubkey = String(argv.pubkey)
      }
      return { method: 'POST', path: '/api/manage/federation/' + subcommand, body }
    }
    case 'unfollow': {
      const url = positional[0]
      if (!isValidUrl(url)) throw new Error('url must start with http:// or https://')
      return {
        method: 'POST',
        path: '/api/manage/federation/unfollow',
        body: { url: url.trim() }
      }
    }
    case 'republish': {
      const appKey = positional[0]
      if (!isValidHexKey(appKey, 64)) {
        throw new Error('appKey must be 64 hex characters')
      }
      const sourceUrl = argv.source
      if (!isValidUrl(sourceUrl)) {
        throw new Error('--source must be set to a URL starting with http:// or https://')
      }
      const body = { appKey, sourceUrl: String(sourceUrl).trim() }
      if (argv.pubkey !== undefined) {
        if (!isValidHexKey(String(argv.pubkey), 64)) {
          throw new Error('--pubkey must be 64 hex characters')
        }
        body.sourcePubkey = String(argv.pubkey)
      }
      if (argv.channel !== undefined) body.channel = String(argv.channel)
      if (argv.note !== undefined) body.note = String(argv.note)
      return { method: 'POST', path: '/api/manage/federation/republish', body }
    }
    case 'unrepublish': {
      const appKey = positional[0]
      if (!isValidHexKey(appKey, 64)) {
        throw new Error('appKey must be 64 hex characters')
      }
      return {
        method: 'POST',
        path: '/api/manage/federation/unrepublish',
        body: { appKey }
      }
    }
    default:
      throw new Error('Unknown federation subcommand: ' + subcommand)
  }
}

export function formatFederationList (payload) {
  if (!payload || typeof payload !== 'object') return 'No federation data.'
  const lines = []
  const subscriptions = Array.isArray(payload.subscriptions) ? payload.subscriptions : []
  const republishes = Array.isArray(payload.republishes) ? payload.republishes : []

  lines.push(`Federation subscriptions: ${subscriptions.length}`)
  if (subscriptions.length === 0) {
    lines.push('  (none)')
  } else {
    for (const s of subscriptions) {
      const pub = s.pubkey ? s.pubkey.slice(0, 12) + '...' : 'no-pubkey'
      lines.push(`  [${s.mode || 'follow'}] ${s.url}  pubkey:${pub}`)
    }
  }

  lines.push('')
  lines.push(`Republishes: ${republishes.length}`)
  if (republishes.length === 0) {
    lines.push('  (none)')
  } else {
    for (const r of republishes) {
      const appKey = r.appKey ? r.appKey.slice(0, 16) + '...' : 'unknown'
      const src = r.sourceUrl || 'no-source'
      const channel = r.channel ? `  channel:${r.channel}` : ''
      lines.push(`  ${appKey}  source:${src}${channel}`)
    }
  }
  return lines.join('\n')
}

export async function runFederationCommand ({
  argv,
  positional,
  env = process.env,
  fetchImpl,
  out = (msg) => console.log(msg),
  err = (msg) => console.error(msg)
}) {
  const subcommand = positional[0]
  if (!subcommand || subcommand === 'help' || argv.help) {
    out(FEDERATION_HELP)
    return 0
  }

  let apiUrl
  try {
    apiUrl = resolveApiUrl(argv)
  } catch (e) {
    err(e.message)
    return 1
  }
  const apiKey = resolveApiKey(argv, env)

  let request
  try {
    request = buildFederationRequest(subcommand, positional.slice(1), argv)
  } catch (e) {
    err(e.message)
    return 1
  }

  let payload
  try {
    payload = await performRequest({
      apiUrl, apiKey, method: request.method, path: request.path, body: request.body, fetchImpl
    })
  } catch (e) {
    err('federation ' + subcommand + ' failed: ' + e.message)
    return 1
  }

  if (subcommand === 'list') {
    out(formatFederationList(payload))
    return 0
  }

  if (subcommand === 'follow') {
    out('OK — following ' + request.body.url)
  } else if (subcommand === 'mirror') {
    out('OK — mirroring ' + request.body.url)
  } else if (subcommand === 'unfollow') {
    out('OK — unfollowed ' + request.body.url + (payload && payload.removed ? '' : ' (no-op)'))
  } else if (subcommand === 'republish') {
    out('OK — republish set for ' + request.body.appKey.slice(0, 16) + '... from ' + request.body.sourceUrl)
  } else if (subcommand === 'unrepublish') {
    out('OK — unrepublish ' + request.body.appKey.slice(0, 16) + '...' + (payload && payload.removed ? '' : ' (no-op)'))
  }
  return 0
}
