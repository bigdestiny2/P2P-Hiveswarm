import test from 'brittle'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm, writeFile, readFile, stat, readdir } from 'fs/promises'
import { RelayNode } from 'p2p-hiverelay/core/relay-node/index.js'
import { Federation } from 'p2p-hiverelay/core/federation.js'

// Security hardening tests for Federation:
//   1. URL validation on follow / mirror / republish (and their persisted load path)
//   2. Atomic write+rename for federation.json (no .tmp leftover; mtime updates)
//
// These mirror the patterns in accept-mode.test.js (brittle + tmpdir mkdtemp)
// but live in a dedicated file so the existing federation tests stay untouched.

function makeNode (overrides = {}) {
  return new RelayNode({ storage: '/tmp/hr-fed-hardening-' + Date.now() + '-' + Math.random(), ...overrides })
}

// ─── URL scheme validation ────────────────────────────────────────────

test('Federation.follow rejects javascript: scheme', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow('javascript:alert(1)'), /scheme must be http/i,
    'javascript: URLs are a known XSS vector — reject before they hit storage')
})

test('Federation.follow rejects file: scheme', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow('file:///etc/passwd'), /scheme must be http/i,
    'file: URLs would let a follow target escape into the local FS')
})

test('Federation.follow rejects data: scheme', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow('data:text/html,<script>1</script>'), /scheme must be http/i)
})

test('Federation.mirror rejects non-http(s) schemes', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.mirror('javascript:alert(1)'), /scheme must be http/i)
  t.exception(() => fed.mirror('ftp://example.com'), /scheme must be http/i)
  t.exception(() => fed.mirror('ws://example.com'), /scheme must be http/i)
})

// ─── Malformed / empty / oversized URLs ───────────────────────────────

test('Federation.follow rejects malformed URL ("not a url")', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow('not a url'), /invalid URL|non-empty string|scheme must be http/i)
})

test('Federation.follow rejects empty string', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow(''), /non-empty string/i)
})

test('Federation.follow rejects non-string input', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.follow(null), /non-empty string/i)
  t.exception(() => fed.follow(undefined), /non-empty string/i)
  t.exception(() => fed.follow(42), /non-empty string/i)
})

test('Federation.follow rejects URLs longer than 2048 chars', async (t) => {
  const fed = new Federation({ node: makeNode() })
  // Build a 2049-char URL: "http://" (7) + "a"*2041 + ".example" (8) = 2056. Trim to 2049.
  const huge = 'http://' + 'a'.repeat(2049 - 'http://'.length)
  t.is(huge.length, 2049, 'sanity: oversized URL is one over the cap')
  t.exception(() => fed.follow(huge), /maximum length/i)
})

test('Federation.follow accepts a URL exactly at the 2048-char cap', async (t) => {
  const fed = new Federation({ node: makeNode() })
  const exact = 'http://' + 'a'.repeat(2048 - 'http://'.length)
  t.is(exact.length, 2048)
  t.execution(() => fed.follow(exact), 'boundary case: 2048 is the inclusive max')
})

// ─── Happy path: standard http/https URLs are accepted ────────────────

test('Federation.follow accepts http:// and https:// URLs', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.execution(() => fed.follow('http://relay.example'))
  t.execution(() => fed.follow('https://relay.example'))
  t.execution(() => fed.follow('https://relay.example:8443/path'))
  t.is(fed.snapshot().followed.length, 3, 'all three valid follows recorded')
})

test('Federation.mirror accepts http:// and https:// URLs', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.execution(() => fed.mirror('http://relay.example'))
  t.execution(() => fed.mirror('https://relay.example', { pubkey: 'a'.repeat(64) }))
  t.is(fed.snapshot().mirrored.length, 2)
})

// ─── republish() validates sourceUrl ──────────────────────────────────

test('Federation.republish validates sourceUrl with the same rules', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.exception(() => fed.republish('a'.repeat(64), { sourceUrl: 'javascript:alert(1)' }),
    /scheme must be http/i, 'republish must not become a sneaky XSS injection vector')
  t.exception(() => fed.republish('a'.repeat(64), { sourceUrl: 'not-a-url' }),
    /invalid URL|scheme must be http/i)
  t.exception(() => fed.republish('a'.repeat(64), { sourceUrl: 'http://' + 'x'.repeat(2050) }),
    /maximum length/i)
})

test('Federation.republish accepts valid sourceUrl and null sourceUrl', async (t) => {
  const fed = new Federation({ node: makeNode() })
  t.execution(() => fed.republish('a'.repeat(64), { sourceUrl: 'https://upstream.example' }))
  // sourceUrl is optional — a null/missing one must still be allowed.
  t.execution(() => fed.republish('b'.repeat(64), { sourceUrl: null }))
  t.execution(() => fed.republish('c'.repeat(64), {}))
  t.is(fed.snapshot().republished.length, 3)
})

// ─── load() resilience: bad entries dropped, valid ones preserved ─────

test('Federation.load skips invalid URL entries and preserves valid ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-load-skip-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  // Hand-craft a federation.json with one good entry and one poisoned one
  // (an attacker editing the JSON, or a stale entry from a corrupted disk).
  const payload = {
    followed: [
      { url: 'http://good.example', pubkey: null, addedAt: 1000 },
      { url: 'javascript:alert(1)', pubkey: null, addedAt: 1001 }, // poisoned
      { url: 'https://also-good.example', pubkey: null, addedAt: 1002 }
    ],
    mirrored: [
      { url: 'file:///etc/passwd', pubkey: null, addedAt: 2000 }, // poisoned
      { url: 'http://mirror-ok.example', pubkey: 'a'.repeat(64), addedAt: 2001 }
    ],
    republished: [
      { appKey: 'k'.repeat(64), sourceUrl: 'data:text/html,bad', addedAt: 3000 }, // poisoned
      { appKey: 'm'.repeat(64), sourceUrl: 'https://upstream.example', addedAt: 3001 }
    ]
  }
  await writeFile(storagePath, JSON.stringify(payload), 'utf8')

  const fed = new Federation({ node: makeNode(), storagePath })
  const skipped = []
  fed.on('persistence-error', (info) => {
    if (info.phase === 'load-skip-invalid') skipped.push(info)
  })

  await fed.load()

  // Valid entries preserved.
  const snap = fed.snapshot()
  t.is(snap.followed.length, 2, 'two valid follows survive')
  t.ok(snap.followed.find(e => e.url === 'http://good.example'))
  t.ok(snap.followed.find(e => e.url === 'https://also-good.example'))

  t.is(snap.mirrored.length, 1, 'one valid mirror survives')
  t.is(snap.mirrored[0].url, 'http://mirror-ok.example')
  t.ok(fed.isMirroredPubkey('a'.repeat(64)), 'mirror pubkey index rebuilt from valid entry')

  t.is(snap.republished.length, 1, 'republished entry with bad sourceUrl dropped')
  t.is(snap.republished[0].appKey, 'm'.repeat(64))

  // 3 bad entries → 3 persistence-error events, all phase 'load-skip-invalid'.
  t.is(skipped.length, 3, 'one persistence-error event per dropped entry')
  t.is(skipped.filter(s => s.kind === 'followed').length, 1)
  t.is(skipped.filter(s => s.kind === 'mirrored').length, 1)
  t.is(skipped.filter(s => s.kind === 'republished').length, 1)
})

// ─── Atomic save: write-to-tmp then rename ────────────────────────────

test('Federation.save is atomic — uses .tmp + rename, leaves no stray .tmp', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-atomic-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  const fed = new Federation({ node: makeNode(), storagePath })
  fed.follow('http://relay-1.example')
  fed.mirror('http://relay-2.example', { pubkey: 'p'.repeat(64) })
  await fed.save()

  // After a successful save, the destination file exists and the .tmp does not.
  const after1 = await readdir(dir)
  t.ok(after1.includes('federation.json'), 'destination written')
  t.absent(after1.includes('federation.json.tmp'), 'no stray .tmp file after success')

  const stat1 = await stat(storagePath)
  const mtime1 = stat1.mtimeMs

  // Bump the state and save again — mtime must advance, proving rename happened.
  // Wait long enough that the FS records a different mtime (10ms is generous on
  // every modern FS we run on).
  await new Promise(resolve => setTimeout(resolve, 20))
  fed.follow('http://relay-3.example')
  await fed.save()

  const stat2 = await stat(storagePath)
  t.ok(stat2.mtimeMs > mtime1, 'mtime advances after second save (rename replaced the file)')

  const after2 = await readdir(dir)
  t.absent(after2.includes('federation.json.tmp'), 'still no stray .tmp file after second save')

  // And the contents are the latest snapshot, not a stale read.
  const raw = await readFile(storagePath, 'utf8')
  const data = JSON.parse(raw)
  t.is(data.followed.length, 2)
  t.is(data.mirrored.length, 1)
  t.ok(data.followed.find(e => e.url === 'http://relay-3.example'))
})

test('Federation.save round-trips through load() (atomic write produces valid JSON)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hr-fed-atomic-rt-'))
  const storagePath = join(dir, 'federation.json')
  t.teardown(() => rm(dir, { recursive: true, force: true }))

  const fed1 = new Federation({ node: makeNode(), storagePath })
  fed1.follow('http://a.example')
  fed1.mirror('http://b.example', { pubkey: 'k'.repeat(64) })
  fed1.republish('z'.repeat(64), { sourceUrl: 'https://up.example', channel: 'ch' })
  await fed1.save()

  const fed2 = new Federation({ node: makeNode(), storagePath })
  await fed2.load()
  const snap = fed2.snapshot()
  t.is(snap.followed.length, 1)
  t.is(snap.mirrored.length, 1)
  t.is(snap.republished.length, 1)
  t.is(snap.republished[0].sourceUrl, 'https://up.example')
})
