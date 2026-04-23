import test from 'brittle'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, rm, readFile } from 'fs/promises'
import { SetupWizard, WIZARD_SCHEMA_VERSION } from 'p2p-hiverelay/core/wizard.js'

async function makeWizard (t) {
  const dir = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  return new SetupWizard({ storagePath: join(dir, 'wizard.json') })
}

test('constructor requires storagePath', async (t) => {
  try {
    // eslint-disable-next-line no-new
    new SetupWizard({})
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('storagePath'))
  }
})

test('initial state starts at welcome with sane defaults', async (t) => {
  const w = await makeWizard(t)
  const snap = w.snapshot()
  t.is(snap.step, 'welcome')
  t.absent(snap.isComplete)
  t.is(snap.acceptMode, 'review')
  t.ok(snap.relayName.length > 0, 'relayName has a generated default')
  t.absent(snap.lnbits.connected, 'no admin key yet → not connected')
})

test('snapshot redacts the LNbits admin key', async (t) => {
  const w = await makeWizard(t)
  await w.setLNbitsCredentials({ adminKey: 'super-secret-key-shhh' })
  const snap = w.snapshot()
  t.is(snap.lnbits.connected, true)
  // The snapshot must NOT contain the actual admin key — only a boolean.
  t.absent('adminKey' in snap.lnbits, 'admin key never leaked through snapshot')
})

test('goToStep validates step name', async (t) => {
  const w = await makeWizard(t)
  const bad = w.goToStep({ step: 'made-up-step' })
  t.absent(bad.ok)
  t.ok(bad.reason.includes('unknown step'))
  const good = w.goToStep({ step: 'lnbits_connect' })
  t.ok(good.ok)
  t.is(good.state.step, 'lnbits_connect')
})

test('first goToStep stamps startedAt', async (t) => {
  const w = await makeWizard(t)
  t.is(w.snapshot().startedAt, null)
  w.goToStep({ step: 'relay_name' })
  t.ok(typeof w.snapshot().startedAt === 'number', 'startedAt set on first navigation')
})

test('setRelayName validates length and emptiness', async (t) => {
  const w = await makeWizard(t)
  t.absent(w.setRelayName({ relayName: '' }).ok, 'empty rejected')
  t.absent(w.setRelayName({ relayName: 'a'.repeat(61) }).ok, '>60 chars rejected')
  t.absent(w.setRelayName({ relayName: 42 }).ok, 'non-string rejected')
  const ok = w.setRelayName({ relayName: '  Tokyo Relay 01  ' })
  t.ok(ok.ok)
  t.is(ok.state.relayName, 'Tokyo Relay 01', 'whitespace trimmed')
})

test('setLNbitsCredentials requires adminKey', async (t) => {
  const w = await makeWizard(t)
  t.absent((await w.setLNbitsCredentials({})).ok)
  t.absent((await w.setLNbitsCredentials({ adminKey: '' })).ok)
  const ok = await w.setLNbitsCredentials({ adminKey: 'k' })
  t.ok(ok.ok)
  t.is(ok.state.lnbits.connected, true)
})

test('setLNbitsCredentials trims trailing slash from URL', async (t) => {
  const w = await makeWizard(t)
  await w.setLNbitsCredentials({ url: 'http://lnbits/////', adminKey: 'k' })
  // URL is in state but redacted out of snapshot — read raw state.
  t.is(w.state.lnbits.url, 'http://lnbits')
})

test('setAcceptMode validates against the four allowed values', async (t) => {
  const w = await makeWizard(t)
  for (const mode of ['open', 'review', 'allowlist', 'closed']) {
    t.ok(w.setAcceptMode({ acceptMode: mode }).ok, `${mode} accepted`)
  }
  t.absent(w.setAcceptMode({ acceptMode: 'random' }).ok, 'invalid mode rejected')
})

test('complete() sets step to complete and stamps completedAt', async (t) => {
  const w = await makeWizard(t)
  w.complete()
  const snap = w.snapshot()
  t.is(snap.step, 'complete')
  t.ok(snap.isComplete)
  t.ok(typeof snap.completedAt === 'number')
})

test('toConfig returns the four wizard-collected settings (decrypts adminKey)', async (t) => {
  const w = await makeWizard(t)
  w.setRelayName({ relayName: 'myrelay' })
  await w.setLNbitsCredentials({ url: 'http://x:5000', adminKey: 'k' })
  w.setAcceptMode({ acceptMode: 'allowlist' })
  const cfg = await w.toConfig()
  t.is(cfg.name, 'myrelay')
  t.is(cfg.acceptMode, 'allowlist')
  t.is(cfg.lnbits.url, 'http://x:5000')
  t.is(cfg.lnbits.adminKey, 'k', 'plaintext returned to caller')
})

test('save + load persists state across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'wizard.json')

  const a = new SetupWizard({ storagePath: path })
  a.setRelayName({ relayName: 'persisted' })
  a.setAcceptMode({ acceptMode: 'open' })
  await a.setLNbitsCredentials({ adminKey: 'persisted-key' })
  a.complete()
  await a.save()

  const b = new SetupWizard({ storagePath: path })
  await b.load()
  t.is(b.snapshot().step, 'complete')
  t.is(b.snapshot().relayName, 'persisted')
  t.is(b.snapshot().acceptMode, 'open')
  t.ok(b.snapshot().lnbits.connected)
  // Admin key on disk MUST be encrypted (envelope object), NOT plaintext.
  const raw = JSON.parse(await readFile(path, 'utf8'))
  t.absent(typeof raw.lnbits.adminKey === 'string' && raw.lnbits.adminKey === 'persisted-key',
    'plaintext admin key MUST NOT appear on disk')
  t.ok(typeof raw.lnbits.adminKey === 'object' && raw.lnbits.adminKey.ciphertext,
    'on-disk adminKey is an encryption envelope')
  // Decryption round-trip recovers plaintext.
  const cfg = await b.toConfig()
  t.is(cfg.lnbits.adminKey, 'persisted-key', 'decrypts to original')
})

test('load is no-op on missing file (first run)', async (t) => {
  const w = await makeWizard(t)
  await w.load() // file doesn't exist yet
  t.is(w.snapshot().step, 'welcome', 'state untouched')
})

test('load tolerates corrupted JSON without crashing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'wizard.json')
  const { writeFile } = await import('fs/promises')
  await writeFile(path, '{this is not json', 'utf8')

  const w = new SetupWizard({ storagePath: path })
  let errored = false
  w.on('load-error', () => { errored = true })
  await w.load()
  t.ok(errored, 'load-error event fired')
  t.is(w.snapshot().step, 'welcome', 'fallback to default state')
})

test('reset clears state back to welcome', async (t) => {
  const w = await makeWizard(t)
  w.setRelayName({ relayName: 'x' })
  await w.setLNbitsCredentials({ adminKey: 'y' })
  w.setAcceptMode({ acceptMode: 'open' })
  w.complete()
  w.reset()
  const snap = w.snapshot()
  t.is(snap.step, 'welcome')
  t.is(snap.acceptMode, 'review')
  t.absent(snap.isComplete)
  t.absent(snap.lnbits.connected)
})

test('schema version is exposed for forward compat checks', async (t) => {
  t.is(WIZARD_SCHEMA_VERSION, 2, 'schemaVersion is 2 after AES-GCM encryption migration')
})

// ─── Encryption-at-rest tests (Defect 1 fix) ──────────────────────

test('admin key on disk uses AES-GCM envelope, never plaintext', async (t) => {
  const w = await makeWizard(t)
  await w.setLNbitsCredentials({ adminKey: 'secret123' })
  await w.save()
  const raw = JSON.parse(await readFile(w.storagePath, 'utf8'))
  // Envelope must be an object with the v=1 envelope shape.
  t.is(typeof raw.lnbits.adminKey, 'object')
  t.is(raw.lnbits.adminKey.v, 1, 'envelope version 1')
  t.ok(raw.lnbits.adminKey.iv, 'has iv')
  t.ok(raw.lnbits.adminKey.ciphertext, 'has ciphertext')
  t.ok(raw.lnbits.adminKey.authTag, 'has auth tag')
  // Plaintext substring must not appear anywhere in the file
  const fileContents = await readFile(w.storagePath, 'utf8')
  t.absent(fileContents.includes('secret123'), 'plaintext absent from disk')
})

test('encryption is deterministic from $APP_SEED (reinstalls keep the same key)', async (t) => {
  const dir1 = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  const dir2 = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => {
    try { await rm(dir1, { recursive: true, force: true }) } catch (_) {}
    try { await rm(dir2, { recursive: true, force: true }) } catch (_) {}
  })

  // Same APP_SEED across two different storage paths.
  const appSeed = 'a'.repeat(64)
  const a = new SetupWizard({ storagePath: join(dir1, 'wizard.json'), appSeed })
  await a.setLNbitsCredentials({ adminKey: 'shared-key' })
  await a.save()

  // The on-disk envelope from instance A is decryptable by a fresh
  // instance B with the same APP_SEED, even though they never shared
  // a wizard.key file.
  const b = new SetupWizard({ storagePath: join(dir2, 'wizard.json'), appSeed })
  // Manually copy the encrypted envelope from A's disk to B's state.
  const aRaw = JSON.parse(await readFile(join(dir1, 'wizard.json'), 'utf8'))
  b.state.lnbits.adminKey = aRaw.lnbits.adminKey
  const bConfig = await b.toConfig()
  t.is(bConfig.lnbits.adminKey, 'shared-key', 'same APP_SEED → can decrypt')
})

test('different $APP_SEED cannot decrypt', async (t) => {
  const dir1 = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  const dir2 = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => {
    try { await rm(dir1, { recursive: true, force: true }) } catch (_) {}
    try { await rm(dir2, { recursive: true, force: true }) } catch (_) {}
  })

  const a = new SetupWizard({ storagePath: join(dir1, 'wizard.json'), appSeed: 'a'.repeat(64) })
  await a.setLNbitsCredentials({ adminKey: 'abc' })
  await a.save()

  const b = new SetupWizard({ storagePath: join(dir2, 'wizard.json'), appSeed: 'b'.repeat(64) })
  const aRaw = JSON.parse(await readFile(join(dir1, 'wizard.json'), 'utf8'))
  b.state.lnbits.adminKey = aRaw.lnbits.adminKey

  let decryptError = null
  b.on('decrypt-error', (e) => { decryptError = e })
  const cfg = await b.toConfig()
  t.is(cfg.lnbits.adminKey, null, 'wrong key returns null, not garbage')
  t.ok(decryptError, 'decrypt-error event fired')
})

test('v1 plaintext on disk → v2 encryption on next save (migration)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'wizard.json')

  // Simulate a v1 wizard.json on disk (plaintext adminKey, schemaVersion 1)
  const { writeFile } = await import('fs/promises')
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    step: 'complete',
    relayName: 'legacy',
    lnbits: { url: 'http://lnbits', adminKey: 'plaintext-from-v1' },
    acceptMode: 'review',
    startedAt: 1000,
    completedAt: 2000
  }), 'utf8')

  const w = new SetupWizard({ storagePath: path, appSeed: 'a'.repeat(64) })
  let migrated = false
  w.on('schema-migrated', () => { migrated = true })
  await w.load()
  t.ok(migrated, 'schema-migrated event fired')

  // Before save(), the on-disk file is still v1 plaintext.
  // toConfig should still return the right plaintext.
  const cfg = await w.toConfig()
  t.is(cfg.lnbits.adminKey, 'plaintext-from-v1')

  // After save(), file is rewritten as v2 encrypted.
  await w.save()
  const raw = JSON.parse(await readFile(path, 'utf8'))
  t.is(raw.schemaVersion, 2)
  t.is(typeof raw.lnbits.adminKey, 'object')
  t.absent(JSON.stringify(raw).includes('plaintext-from-v1'),
    'plaintext from v1 file is gone after migration')
})

test('storage permissions tightened to 0600 after save', async (t) => {
  const w = await makeWizard(t)
  await w.setLNbitsCredentials({ adminKey: 'check-perms' })
  await w.save()
  const { stat } = await import('fs/promises')
  const st = await stat(w.storagePath)
  // On macOS/Linux, mode includes file type bits — mask to perms.
  const perms = st.mode & 0o777
  t.is(perms, 0o600, 'wizard.json is owner-read/write only')
})
