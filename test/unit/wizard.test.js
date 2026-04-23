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
  w.setLNbitsCredentials({ adminKey: 'super-secret-key-shhh' })
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
  t.absent(w.setLNbitsCredentials({}).ok)
  t.absent(w.setLNbitsCredentials({ adminKey: '' }).ok)
  const ok = w.setLNbitsCredentials({ adminKey: 'k' })
  t.ok(ok.ok)
  t.is(ok.state.lnbits.connected, true)
})

test('setLNbitsCredentials trims trailing slash from URL', async (t) => {
  const w = await makeWizard(t)
  w.setLNbitsCredentials({ url: 'http://lnbits/////', adminKey: 'k' })
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

test('toConfig returns the four wizard-collected settings', async (t) => {
  const w = await makeWizard(t)
  w.setRelayName({ relayName: 'myrelay' })
  w.setLNbitsCredentials({ url: 'http://x:5000', adminKey: 'k' })
  w.setAcceptMode({ acceptMode: 'allowlist' })
  const cfg = w.toConfig()
  t.is(cfg.name, 'myrelay')
  t.is(cfg.acceptMode, 'allowlist')
  t.is(cfg.lnbits.url, 'http://x:5000')
  t.is(cfg.lnbits.adminKey, 'k')
})

test('save + load persists state across instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bs-wizard-'))
  t.teardown(async () => { try { await rm(dir, { recursive: true, force: true }) } catch (_) {} })
  const path = join(dir, 'wizard.json')

  const a = new SetupWizard({ storagePath: path })
  a.setRelayName({ relayName: 'persisted' })
  a.setAcceptMode({ acceptMode: 'open' })
  a.setLNbitsCredentials({ adminKey: 'persisted-key' })
  a.complete()
  await a.save()

  const b = new SetupWizard({ storagePath: path })
  await b.load()
  t.is(b.snapshot().step, 'complete')
  t.is(b.snapshot().relayName, 'persisted')
  t.is(b.snapshot().acceptMode, 'open')
  t.ok(b.snapshot().lnbits.connected)
  // Admin key SHOULD be present on disk for the relay to use, but
  // SHOULD NOT appear in the snapshot.
  const raw = JSON.parse(await readFile(path, 'utf8'))
  t.is(raw.lnbits.adminKey, 'persisted-key')
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
  w.setLNbitsCredentials({ adminKey: 'y' })
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
  t.is(WIZARD_SCHEMA_VERSION, 1)
})
