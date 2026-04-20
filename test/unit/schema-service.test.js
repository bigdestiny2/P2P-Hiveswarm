import test from 'brittle'
import { SchemaService } from 'p2p-hiveservices/builtin/schema-service.js'

function createService () {
  const svc = new SchemaService()
  svc.start({ node: null })
  return svc
}

const txSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: {
    from: { type: 'string', minLength: 1 },
    to: { type: 'string', minLength: 1 },
    amount: { type: 'number', minimum: 0 },
    memo: { type: 'string', maxLength: 256 }
  }
}

test('SchemaService - manifest', async (t) => {
  const svc = new SchemaService()
  const m = svc.manifest()
  t.is(m.name, 'schema')
  t.ok(m.capabilities.includes('register'))
  t.ok(m.capabilities.includes('validate'))
})

test('SchemaService - register and get', async (t) => {
  const svc = createService()
  const entry = await svc.register({ schemaId: 'tx.v1', version: '1.0.0', definition: txSchema })
  t.is(entry.schemaId, 'tx.v1')
  t.is(entry.version, '1.0.0')

  const got = await svc.get({ schemaId: 'tx.v1' })
  t.is(got.version, '1.0.0')
})

test('SchemaService - duplicate version rejected', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx.v1', version: '1.0.0', definition: txSchema })
  try {
    await svc.register({ schemaId: 'tx.v1', version: '1.0.0', definition: txSchema })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('SCHEMA_VERSION_EXISTS'))
  }
})

test('SchemaService - get specific version', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })
  await svc.register({ schemaId: 'tx', version: '2.0.0', definition: { ...txSchema, required: ['from', 'to'] } })

  const v1 = await svc.get({ schemaId: 'tx', version: '1.0.0' })
  t.is(v1.version, '1.0.0')

  const latest = await svc.get({ schemaId: 'tx' })
  t.is(latest.version, '2.0.0')
})

test('SchemaService - get not found', async (t) => {
  const svc = createService()
  try {
    await svc.get({ schemaId: 'nonexistent' })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('SCHEMA_NOT_FOUND'))
  }
})

test('SchemaService - list returns latest versions', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'a', version: '1.0.0', definition: {} })
  await svc.register({ schemaId: 'b', version: '1.0.0', definition: {} })
  await svc.register({ schemaId: 'a', version: '2.0.0', definition: {} })

  const list = await svc.list()
  t.is(list.length, 2)
  const aEntry = list.find(e => e.schemaId === 'a')
  t.is(aEntry.version, '2.0.0')
})

test('SchemaService - versions', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'x', version: '1.0.0', definition: {} })
  await svc.register({ schemaId: 'x', version: '1.1.0', definition: {} })

  const versions = await svc.versions({ schemaId: 'x' })
  t.is(versions.length, 2)
  t.is(versions[0].version, '1.0.0')
  t.is(versions[1].version, '1.1.0')
})

test('SchemaService - validate passes valid data', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })

  const result = await svc.validate({ schemaId: 'tx', data: { from: 'alice', to: 'bob', amount: 100 } })
  t.is(result.valid, true)
  t.is(result.errors.length, 0)
})

test('SchemaService - validate catches missing required field', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })

  const result = await svc.validate({ schemaId: 'tx', data: { from: 'alice' } })
  t.is(result.valid, false)
  t.ok(result.errors.some(e => e.includes('to') && e.includes('required')))
  t.ok(result.errors.some(e => e.includes('amount') && e.includes('required')))
})

test('SchemaService - validate catches wrong type', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })

  const result = await svc.validate({ schemaId: 'tx', data: { from: 'alice', to: 'bob', amount: 'not-a-number' } })
  t.is(result.valid, false)
  t.ok(result.errors.some(e => e.includes('amount') && e.includes('number')))
})

test('SchemaService - validate checks minimum/maximum', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })

  const result = await svc.validate({ schemaId: 'tx', data: { from: 'a', to: 'b', amount: -5 } })
  t.is(result.valid, false)
  t.ok(result.errors.some(e => e.includes('minimum')))
})

test('SchemaService - validate checks maxLength', async (t) => {
  const svc = createService()
  await svc.register({ schemaId: 'tx', version: '1.0.0', definition: txSchema })

  const result = await svc.validate({ schemaId: 'tx', data: { from: 'a', to: 'b', amount: 1, memo: 'x'.repeat(300) } })
  t.is(result.valid, false)
  t.ok(result.errors.some(e => e.includes('maxLength')))
})

test('SchemaService - validate checks enum', async (t) => {
  const svc = createService()
  const enumSchema = { type: 'object', properties: { status: { type: 'string', enum: ['active', 'closed'] } } }
  await svc.register({ schemaId: 'status', version: '1.0.0', definition: enumSchema })

  const good = await svc.validate({ schemaId: 'status', data: { status: 'active' } })
  t.is(good.valid, true)

  const bad = await svc.validate({ schemaId: 'status', data: { status: 'pending' } })
  t.is(bad.valid, false)
})

test('SchemaService - validate checks array items', async (t) => {
  const svc = createService()
  const arrSchema = { type: 'array', items: { type: 'number' } }
  await svc.register({ schemaId: 'nums', version: '1.0.0', definition: arrSchema })

  const good = await svc.validate({ schemaId: 'nums', data: [1, 2, 3] })
  t.is(good.valid, true)

  const bad = await svc.validate({ schemaId: 'nums', data: [1, 'two', 3] })
  t.is(bad.valid, false)
})

test('SchemaService - register validates inputs', async (t) => {
  const svc = createService()

  try { await svc.register({}); t.fail() } catch (e) { t.ok(e.message.includes('SCHEMA_MISSING_ID')) }
  try { await svc.register({ schemaId: 'x' }); t.fail() } catch (e) { t.ok(e.message.includes('SCHEMA_MISSING_VERSION')) }
  try { await svc.register({ schemaId: 'x', version: '1' }); t.fail() } catch (e) { t.ok(e.message.includes('SCHEMA_MISSING_DEFINITION')) }
})
