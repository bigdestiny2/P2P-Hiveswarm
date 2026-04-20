import test from 'brittle'
import {
  buildCatalogRequest,
  parseAllowlist,
  isValidHexKey,
  resolveApiUrl,
  resolveApiKey,
  formatPending,
  runCatalogCommand
} from 'p2p-hiverelay/cli/catalog.js'
import {
  buildFederationRequest,
  isValidUrl,
  formatFederationList,
  runFederationCommand
} from 'p2p-hiverelay/cli/federation.js'

const HEX64 = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)

// ─── helpers ────────────────────────────────────────────────────────

function makeFakeFetch (response) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const r = typeof response === 'function' ? response({ url, init }) : response
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      statusText: r.statusText || 'OK',
      text: async () => r.text === undefined ? JSON.stringify(r.body || {}) : r.text
    }
  }
  return { fetchImpl, calls }
}

function captureStreams () {
  const out = []
  const err = []
  return {
    out: (msg) => out.push(String(msg)),
    err: (msg) => err.push(String(msg)),
    outLines: out,
    errLines: err
  }
}

// ─── pure helpers ───────────────────────────────────────────────────

test('catalog: isValidHexKey accepts 64 hex chars and rejects others', (t) => {
  t.is(isValidHexKey(HEX64), true)
  t.is(isValidHexKey(HEX64.toUpperCase()), true)
  t.is(isValidHexKey('xyz'), false)
  t.is(isValidHexKey('a'.repeat(63)), false)
  t.is(isValidHexKey('a'.repeat(65)), false)
  t.is(isValidHexKey(''), false)
  t.is(isValidHexKey(null), false)
})

test('catalog: parseAllowlist splits comma-separated values and trims', (t) => {
  t.alike(parseAllowlist('a,b,c'), ['a', 'b', 'c'])
  t.alike(parseAllowlist(' a , b , c '), ['a', 'b', 'c'])
  t.alike(parseAllowlist(''), [])
  t.alike(parseAllowlist(undefined), [])
  t.alike(parseAllowlist(['a,b', 'c']), ['a', 'b', 'c'])
})

test('catalog: resolveApiUrl defaults to http://127.0.0.1:9100', (t) => {
  t.is(resolveApiUrl({}), 'http://127.0.0.1:9100')
})

test('catalog: resolveApiUrl normalizes and strips trailing slash', (t) => {
  t.is(resolveApiUrl({ 'api-url': 'http://example.com:9100/' }), 'http://example.com:9100')
  t.is(resolveApiUrl({ 'api-url': 'https://relay.example' }), 'https://relay.example')
})

test('catalog: resolveApiUrl rejects URLs missing http(s)://', (t) => {
  t.exception(() => resolveApiUrl({ 'api-url': 'example.com' }), /must start with http/)
  t.exception(() => resolveApiUrl({ 'api-url': 'ftp://x' }), /must start with http/)
})

test('catalog: resolveApiKey prefers --api-key flag, then env', (t) => {
  t.is(resolveApiKey({ 'api-key': 'flagkey' }, { HIVERELAY_API_KEY: 'envkey' }), 'flagkey')
  t.is(resolveApiKey({}, { HIVERELAY_API_KEY: 'envkey' }), 'envkey')
  t.is(resolveApiKey({}, {}), null)
})

// ─── catalog request builder ────────────────────────────────────────

test('catalog: buildCatalogRequest mode — valid modes', (t) => {
  for (const m of ['open', 'review', 'allowlist', 'closed']) {
    const r = buildCatalogRequest('mode', [m], {})
    t.is(r.method, 'POST')
    t.is(r.path, '/api/manage/catalog/mode')
    t.alike(r.body, { mode: m })
  }
})

test('catalog: buildCatalogRequest mode — invalid mode throws', (t) => {
  t.exception(() => buildCatalogRequest('mode', ['nope'], {}), /one of/)
  t.exception(() => buildCatalogRequest('mode', [], {}), /one of/)
})

test('catalog: buildCatalogRequest allowlist — valid pubkeys', (t) => {
  const r = buildCatalogRequest('allowlist', [HEX64 + ',' + HEX64_B], {})
  t.is(r.method, 'POST')
  t.is(r.path, '/api/manage/catalog/allowlist')
  t.alike(r.body, { allowlist: [HEX64, HEX64_B] })
})

test('catalog: buildCatalogRequest allowlist — empty list throws', (t) => {
  t.exception(() => buildCatalogRequest('allowlist', [''], {}), /at least one pubkey/)
  t.exception(() => buildCatalogRequest('allowlist', [], {}), /at least one pubkey/)
})

test('catalog: buildCatalogRequest allowlist — non-hex entry throws', (t) => {
  t.exception(() => buildCatalogRequest('allowlist', ['xyz'], {}), /64 hex/)
  t.exception(() => buildCatalogRequest('allowlist', [HEX64 + ',xyz'], {}), /64 hex/)
})

test('catalog: buildCatalogRequest approve/reject/remove — valid appKey', (t) => {
  for (const sub of ['approve', 'reject', 'remove']) {
    const r = buildCatalogRequest(sub, [HEX64], {})
    t.is(r.method, 'POST')
    t.is(r.path, '/api/manage/catalog/' + sub)
    t.alike(r.body, { appKey: HEX64 })
  }
})

test('catalog: buildCatalogRequest approve/reject/remove — invalid appKey throws', (t) => {
  for (const sub of ['approve', 'reject', 'remove']) {
    t.exception(() => buildCatalogRequest(sub, ['notHex'], {}), /64 hex/)
    t.exception(() => buildCatalogRequest(sub, [], {}), /64 hex/)
  }
})

test('catalog: buildCatalogRequest pending — GET, no body', (t) => {
  const r = buildCatalogRequest('pending', [], {})
  t.is(r.method, 'GET')
  t.is(r.path, '/api/manage/catalog/pending')
  t.is(r.body, null)
})

test('catalog: buildCatalogRequest unknown subcommand throws', (t) => {
  t.exception(() => buildCatalogRequest('frobnicate', [], {}), /Unknown catalog/)
})

// ─── catalog dispatcher (request shape + auth) ──────────────────────

test('catalog: runCatalogCommand mode — sends POST with bearer auth', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true, mode: 'review' } })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: { 'api-url': 'http://relay.test', 'api-key': 'secret' },
    positional: ['mode', 'review'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 0)
  t.is(calls.length, 1)
  t.is(calls[0].url, 'http://relay.test/api/manage/catalog/mode')
  t.is(calls[0].init.method, 'POST')
  t.is(calls[0].init.headers.Authorization, 'Bearer secret')
  t.is(calls[0].init.headers['Content-Type'], 'application/json')
  t.alike(JSON.parse(calls[0].init.body), { mode: 'review' })
  t.ok(streams.outLines[0].includes('OK'))
})

test('catalog: runCatalogCommand reads HIVERELAY_API_KEY from env', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  await runCatalogCommand({
    argv: {},
    positional: ['approve', HEX64],
    env: { HIVERELAY_API_KEY: 'envsecret' },
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(calls[0].init.headers.Authorization, 'Bearer envsecret')
  t.is(calls[0].url, 'http://127.0.0.1:9100/api/manage/catalog/approve')
})

test('catalog: runCatalogCommand pending — GET, pretty-prints', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({
    body: {
      count: 1,
      mode: 'review',
      requests: [{
        appKey: HEX64,
        publisherPubkey: HEX64_B,
        privacyTier: 'public',
        discoveredAt: 1700000000000
      }]
    }
  })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {}, positional: ['pending'], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.is(code, 0)
  t.is(calls[0].init.method, 'GET')
  t.absent(calls[0].init.body)
  const printed = streams.outLines.join('\n')
  t.ok(printed.includes('Pending requests: 1'))
  t.ok(printed.includes('mode: review'))
  t.ok(printed.includes(HEX64.slice(0, 16)))
})

test('catalog: runCatalogCommand pending — empty queue', async (t) => {
  const { fetchImpl } = makeFakeFetch({ body: { count: 0, mode: 'open', requests: [] } })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {}, positional: ['pending'], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.is(code, 0)
  t.ok(streams.outLines[0].includes('No pending'))
})

test('catalog: runCatalogCommand returns exit code 1 on validation failure', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: {} })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {}, positional: ['mode', 'invalid'], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.is(code, 1)
  t.is(calls.length, 0, 'no HTTP call made on validation failure')
  t.ok(streams.errLines.length > 0)
})

test('catalog: runCatalogCommand returns exit code 1 on bad --api-url', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: {} })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: { 'api-url': 'no-scheme' },
    positional: ['mode', 'open'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 1)
  t.is(calls.length, 0)
})

test('catalog: runCatalogCommand returns exit code 1 on HTTP error', async (t) => {
  const { fetchImpl } = makeFakeFetch({ ok: false, status: 401, statusText: 'Unauthorized', body: { error: 'API key required' } })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {}, positional: ['approve', HEX64], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.is(code, 1)
  t.ok(streams.errLines[0].includes('API key required'))
})

test('catalog: runCatalogCommand allowlist sends array of pubkeys', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true, allowlist: [HEX64, HEX64_B] } })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {},
    positional: ['allowlist', HEX64 + ',' + HEX64_B],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 0)
  const sent = JSON.parse(calls[0].init.body)
  t.alike(sent, { allowlist: [HEX64, HEX64_B] })
})

test('catalog: runCatalogCommand allowlist invalid hex returns exit 1', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: {} })
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {},
    positional: ['allowlist', 'not-hex'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 1)
  t.is(calls.length, 0)
})

test('catalog: formatPending handles missing fields gracefully', (t) => {
  t.is(formatPending(null), 'No pending catalog requests (mode: unknown).')
  t.is(formatPending({ requests: [] }), 'No pending catalog requests (mode: unknown).')
  const printed = formatPending({
    count: 1,
    mode: 'review',
    requests: [{ appKey: HEX64 }]
  })
  t.ok(printed.includes('Pending requests: 1'))
  t.ok(printed.includes('publisher:unknown'))
})

test('catalog: runCatalogCommand help — prints help, exit 0', async (t) => {
  const streams = captureStreams()
  const code = await runCatalogCommand({
    argv: {}, positional: [], env: {}, out: streams.out, err: streams.err
  })
  t.is(code, 0)
  t.ok(streams.outLines[0].includes('Usage:'))
})

test('catalog: runCatalogCommand without api-key sends no Authorization header', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  await runCatalogCommand({
    argv: {}, positional: ['approve', HEX64], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.absent(calls[0].init.headers.Authorization)
})

// ─── federation pure helpers ────────────────────────────────────────

test('federation: isValidUrl accepts http/https only', (t) => {
  t.is(isValidUrl('http://x.com'), true)
  t.is(isValidUrl('https://x.com'), true)
  t.is(isValidUrl('  http://x.com  '), true)
  t.is(isValidUrl('ftp://x.com'), false)
  t.is(isValidUrl('x.com'), false)
  t.is(isValidUrl(''), false)
  t.is(isValidUrl(null), false)
})

// ─── federation request builder ─────────────────────────────────────

test('federation: buildFederationRequest list — GET', (t) => {
  const r = buildFederationRequest('list', [], {})
  t.is(r.method, 'GET')
  t.is(r.path, '/api/manage/federation')
  t.is(r.body, null)
})

test('federation: buildFederationRequest follow — valid url', (t) => {
  const r = buildFederationRequest('follow', ['https://relay.example'], {})
  t.is(r.method, 'POST')
  t.is(r.path, '/api/manage/federation/follow')
  t.alike(r.body, { url: 'https://relay.example' })
})

test('federation: buildFederationRequest follow — with --pubkey', (t) => {
  const r = buildFederationRequest('follow', ['https://relay.example'], { pubkey: HEX64 })
  t.alike(r.body, { url: 'https://relay.example', pubkey: HEX64 })
})

test('federation: buildFederationRequest follow — invalid url throws', (t) => {
  t.exception(() => buildFederationRequest('follow', ['relay.example'], {}), /http/)
  t.exception(() => buildFederationRequest('follow', [], {}), /http/)
})

test('federation: buildFederationRequest follow — invalid pubkey throws', (t) => {
  t.exception(
    () => buildFederationRequest('follow', ['http://x'], { pubkey: 'short' }),
    /64 hex/
  )
})

test('federation: buildFederationRequest mirror — POSTs to mirror endpoint', (t) => {
  const r = buildFederationRequest('mirror', ['http://x'], {})
  t.is(r.path, '/api/manage/federation/mirror')
})

test('federation: buildFederationRequest unfollow — POSTs url', (t) => {
  const r = buildFederationRequest('unfollow', ['http://x'], {})
  t.is(r.method, 'POST')
  t.is(r.path, '/api/manage/federation/unfollow')
  t.alike(r.body, { url: 'http://x' })
})

test('federation: buildFederationRequest republish — minimal valid', (t) => {
  const r = buildFederationRequest('republish', [HEX64], { source: 'http://upstream' })
  t.is(r.method, 'POST')
  t.is(r.path, '/api/manage/federation/republish')
  t.alike(r.body, { appKey: HEX64, sourceUrl: 'http://upstream' })
})

test('federation: buildFederationRequest republish — with all options', (t) => {
  const r = buildFederationRequest('republish', [HEX64], {
    source: 'http://upstream',
    pubkey: HEX64_B,
    channel: 'partners',
    note: 'curated'
  })
  t.alike(r.body, {
    appKey: HEX64,
    sourceUrl: 'http://upstream',
    sourcePubkey: HEX64_B,
    channel: 'partners',
    note: 'curated'
  })
})

test('federation: buildFederationRequest republish — invalid appKey throws', (t) => {
  t.exception(
    () => buildFederationRequest('republish', ['x'], { source: 'http://x' }),
    /64 hex/
  )
})

test('federation: buildFederationRequest republish — missing/invalid --source throws', (t) => {
  t.exception(
    () => buildFederationRequest('republish', [HEX64], {}),
    /--source/
  )
  t.exception(
    () => buildFederationRequest('republish', [HEX64], { source: 'no-scheme' }),
    /--source/
  )
})

test('federation: buildFederationRequest republish — invalid pubkey throws', (t) => {
  t.exception(
    () => buildFederationRequest('republish', [HEX64], { source: 'http://x', pubkey: 'short' }),
    /64 hex/
  )
})

test('federation: buildFederationRequest unrepublish — appKey body', (t) => {
  const r = buildFederationRequest('unrepublish', [HEX64], {})
  t.is(r.method, 'POST')
  t.is(r.path, '/api/manage/federation/unrepublish')
  t.alike(r.body, { appKey: HEX64 })
})

test('federation: buildFederationRequest unrepublish — invalid appKey throws', (t) => {
  t.exception(() => buildFederationRequest('unrepublish', ['x'], {}), /64 hex/)
})

test('federation: buildFederationRequest unknown subcommand throws', (t) => {
  t.exception(() => buildFederationRequest('frobnicate', [], {}), /Unknown federation/)
})

// ─── federation dispatcher ──────────────────────────────────────────

test('federation: runFederationCommand list — GET, pretty-prints', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({
    body: {
      subscriptions: [{ url: 'http://up.example', mode: 'follow', pubkey: HEX64 }],
      republishes: [{ appKey: HEX64_B, sourceUrl: 'http://up.example', channel: 'main' }]
    }
  })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {}, positional: ['list'], env: {}, fetchImpl, out: streams.out, err: streams.err
  })
  t.is(code, 0)
  t.is(calls[0].init.method, 'GET')
  t.is(calls[0].url, 'http://127.0.0.1:9100/api/manage/federation')
  const printed = streams.outLines.join('\n')
  t.ok(printed.includes('Federation subscriptions: 1'))
  t.ok(printed.includes('Republishes: 1'))
  t.ok(printed.includes('http://up.example'))
})

test('federation: runFederationCommand follow — POST with bearer auth', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: { 'api-key': 'secret' },
    positional: ['follow', 'http://relay.example'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 0)
  t.is(calls[0].init.method, 'POST')
  t.is(calls[0].url, 'http://127.0.0.1:9100/api/manage/federation/follow')
  t.is(calls[0].init.headers.Authorization, 'Bearer secret')
  t.alike(JSON.parse(calls[0].init.body), { url: 'http://relay.example' })
})

test('federation: runFederationCommand republish — sends sourceUrl/channel/note', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: { source: 'http://upstream', channel: 'partners', note: 'curated' },
    positional: ['republish', HEX64],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 0)
  const sent = JSON.parse(calls[0].init.body)
  t.alike(sent, {
    appKey: HEX64,
    sourceUrl: 'http://upstream',
    channel: 'partners',
    note: 'curated'
  })
})

test('federation: runFederationCommand exit 1 on bad URL', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: {} })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {},
    positional: ['follow', 'not-a-url'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 1)
  t.is(calls.length, 0)
})

test('federation: runFederationCommand exit 1 on missing --source for republish', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: {} })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {},
    positional: ['republish', HEX64],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 1)
  t.is(calls.length, 0)
})

test('federation: runFederationCommand exit 1 on HTTP error', async (t) => {
  const { fetchImpl } = makeFakeFetch({ ok: false, status: 503, statusText: 'Service Unavailable', body: { error: 'Federation not initialized' } })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {},
    positional: ['follow', 'http://x'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 1)
  t.ok(streams.errLines[0].includes('Federation not initialized'))
})

test('federation: runFederationCommand help — prints help, exit 0', async (t) => {
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {}, positional: [], env: {}, out: streams.out, err: streams.err
  })
  t.is(code, 0)
  t.ok(streams.outLines[0].includes('Usage:'))
})

test('federation: formatFederationList handles empty payload', (t) => {
  const printed = formatFederationList({})
  t.ok(printed.includes('Federation subscriptions: 0'))
  t.ok(printed.includes('Republishes: 0'))
})

test('federation: runFederationCommand custom --api-url is used', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  await runFederationCommand({
    argv: { 'api-url': 'https://custom.example:8443' },
    positional: ['list'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(calls[0].url, 'https://custom.example:8443/api/manage/federation')
})

test('federation: runFederationCommand mirror sends to mirror path', async (t) => {
  const { fetchImpl, calls } = makeFakeFetch({ body: { ok: true } })
  const streams = captureStreams()
  await runFederationCommand({
    argv: {},
    positional: ['mirror', 'http://x'],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(calls[0].url, 'http://127.0.0.1:9100/api/manage/federation/mirror')
  t.alike(JSON.parse(calls[0].init.body), { url: 'http://x' })
})

test('federation: runFederationCommand unrepublish — exit 0 even when removed=false', async (t) => {
  const { fetchImpl } = makeFakeFetch({ body: { ok: true, removed: false, appKey: HEX64 } })
  const streams = captureStreams()
  const code = await runFederationCommand({
    argv: {},
    positional: ['unrepublish', HEX64],
    env: {},
    fetchImpl,
    out: streams.out,
    err: streams.err
  })
  t.is(code, 0)
  t.ok(streams.outLines[0].includes('no-op'))
})
