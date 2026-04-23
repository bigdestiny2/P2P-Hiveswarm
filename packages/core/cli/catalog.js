/**
 * HiveRelay CLI — `catalog` subcommand surface.
 *
 * Operator-facing wrappers around the relay's /api/manage/catalog/* HTTP
 * endpoints. Each function makes one HTTP call against the running relay,
 * pretty-prints the response (or a one-line success/error), and returns
 * an exit code (0 for success, 1 for failure) — the caller chooses
 * whether to actually call process.exit.
 *
 * Auth: pass `apiKey` (resolved from --api-key flag or HIVERELAY_API_KEY).
 * Network: pass an explicit `fetchImpl` for testing; falls back to
 * globalThis.fetch.
 */

const VALID_MODES = ['open', 'review', 'allowlist', 'closed']

export const CATALOG_HELP = `Usage:
  hiverelay catalog mode <open|review|allowlist|closed>
  hiverelay catalog allowlist <pubkey>[,<pubkey>...]    # replaces the list
  hiverelay catalog approve <appKey>
  hiverelay catalog reject <appKey>
  hiverelay catalog remove <appKey>
  hiverelay catalog pending                              # lists current queue

Options:
  --api-url <url>      Relay API base URL (default: http://127.0.0.1:9100)
  --api-key <key>      API key (or use HIVERELAY_API_KEY env)
`

export function isValidHexKey (value, length = 64) {
  return typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)
}

export function normalizeApiUrl (value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (!(raw.startsWith('http://') || raw.startsWith('https://'))) return ''
  return raw.replace(/\/+$/, '')
}

export function resolveApiUrl (argv) {
  const supplied = argv['api-url']
  if (supplied !== undefined) {
    const normalized = normalizeApiUrl(supplied)
    if (!normalized) {
      throw new Error('--api-url must start with http:// or https://')
    }
    return normalized
  }
  return 'http://127.0.0.1:9100'
}

export function resolveApiKey (argv, env = process.env) {
  const flag = typeof argv['api-key'] === 'string' ? argv['api-key'].trim() : ''
  return flag || env.HIVERELAY_API_KEY || null
}

export function parseAllowlist (raw) {
  if (raw === undefined || raw === null) return []
  return []
    .concat(raw)
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean)
}

/**
 * Build the HTTP request descriptor for a given catalog subcommand and
 * positional arguments. Returns `{ method, path, body }` or throws an
 * Error with a human-readable message describing the validation failure.
 */
export function buildCatalogRequest (subcommand, positional, argv = {}) {
  switch (subcommand) {
    case 'mode': {
      const mode = positional[0]
      if (!VALID_MODES.includes(mode)) {
        throw new Error('mode must be one of: ' + VALID_MODES.join(', '))
      }
      return { method: 'POST', path: '/api/manage/catalog/mode', body: { mode } }
    }
    case 'allowlist': {
      const list = parseAllowlist(positional[0])
      if (list.length === 0) {
        throw new Error('allowlist requires at least one pubkey (comma-separated)')
      }
      for (const k of list) {
        if (!isValidHexKey(k, 64)) {
          throw new Error('allowlist entries must be 64 hex characters: ' + k)
        }
      }
      return { method: 'POST', path: '/api/manage/catalog/allowlist', body: { allowlist: list } }
    }
    case 'approve':
    case 'reject':
    case 'remove': {
      const appKey = positional[0]
      if (!isValidHexKey(appKey, 64)) {
        throw new Error('appKey must be 64 hex characters')
      }
      return { method: 'POST', path: '/api/manage/catalog/' + subcommand, body: { appKey } }
    }
    case 'pending': {
      return { method: 'GET', path: '/api/manage/catalog/pending', body: null }
    }
    default:
      throw new Error('Unknown catalog subcommand: ' + subcommand)
  }
}

export async function performRequest ({ apiUrl, apiKey, method, path, body, fetchImpl }) {
  const fetchFn = fetchImpl || globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is not available — Node 18+ required')
  }
  const headers = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  const init = { method, headers }
  if (body !== null && body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetchFn(apiUrl + path, init)
  } catch (err) {
    throw new Error(`cannot reach relay ${apiUrl}: ${err.message}`)
  }
  const text = await res.text()
  let payload = null
  if (text) {
    try { payload = JSON.parse(text) } catch (_) { payload = { raw: text } }
  }
  if (!res.ok) {
    const reason = payload && payload.error ? payload.error : `${res.status} ${res.statusText}`
    const err = new Error(reason)
    err.status = res.status
    err.payload = payload
    throw err
  }
  return payload || {}
}

export function formatPending (payload) {
  if (!payload || !Array.isArray(payload.requests) || payload.requests.length === 0) {
    return `No pending catalog requests (mode: ${payload?.mode || 'unknown'}).`
  }
  const lines = []
  lines.push(`Pending requests: ${payload.count} (mode: ${payload.mode || 'unknown'})`)
  for (const r of payload.requests) {
    const appKey = r.appKey ? r.appKey.slice(0, 16) + '...' : 'unknown'
    const publisher = r.publisherPubkey ? r.publisherPubkey.slice(0, 12) + '...' : 'unknown'
    const ts = r.discoveredAt ? new Date(r.discoveredAt).toISOString() : 'n/a'
    const tier = r.privacyTier || 'unknown'
    lines.push(`  ${appKey}  publisher:${publisher}  tier:${tier}  at:${ts}`)
  }
  return lines.join('\n')
}

/**
 * Top-level dispatcher for `hiverelay catalog <subcommand> ...`.
 * Returns a numeric exit code and emits output via `out`/`err` writers.
 */
export async function runCatalogCommand ({
  argv,
  positional,
  env = process.env,
  fetchImpl,
  out = (msg) => console.log(msg),
  err = (msg) => console.error(msg)
}) {
  const subcommand = positional[0]
  if (!subcommand || subcommand === 'help' || argv.help) {
    out(CATALOG_HELP)
    return subcommand ? 0 : 0
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
    request = buildCatalogRequest(subcommand, positional.slice(1), argv)
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
    err('catalog ' + subcommand + ' failed: ' + e.message)
    return 1
  }

  if (subcommand === 'pending') {
    out(formatPending(payload))
    return 0
  }

  // Write subcommands: short success line.
  if (subcommand === 'mode') {
    out(`OK — catalog mode set to ${payload.mode || request.body.mode}`)
  } else if (subcommand === 'allowlist') {
    const len = (payload.allowlist || request.body.allowlist).length
    out(`OK — allowlist replaced (${len} pubkey${len === 1 ? '' : 's'})`)
  } else if (subcommand === 'approve') {
    out('OK — approved ' + request.body.appKey.slice(0, 16) + '...')
  } else if (subcommand === 'reject') {
    out('OK — rejected ' + request.body.appKey.slice(0, 16) + '...')
  } else if (subcommand === 'remove') {
    out('OK — removed ' + request.body.appKey.slice(0, 16) + '...')
  }
  return 0
}
