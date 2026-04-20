import test from 'brittle'
import { ERR, formatErr, classifyErr, isErr } from 'p2p-hiverelay/core/error-prefixes.js'

test('ERR is frozen (can not be mutated at runtime)', async (t) => {
  t.ok(Object.isFrozen(ERR))
  // Attempting to mutate should either throw in strict mode or silently fail
  // — either way, the map stays intact.
  try { ERR.AUTH_REQUIRED = 'hacked: ' } catch (_) {}
  t.is(ERR.AUTH_REQUIRED, 'auth-required: ')
})

test('formatErr combines prefix + message', async (t) => {
  t.is(formatErr('AUTH_REQUIRED', 'sign in first'), 'auth-required: sign in first')
  t.is(formatErr('PAYMENT_REQUIRED', 'topup needed'), 'payment-required: topup needed')
  t.is(formatErr('ACCEPT_QUEUED', 'operator will review'), 'accept-mode-queued: operator will review')
})

test('formatErr with empty message still gives a usable prefix line', async (t) => {
  t.is(formatErr('AUTH_REQUIRED'), 'auth-required: ')
  t.is(formatErr('AUTH_REQUIRED', ''), 'auth-required: ')
})

test('formatErr throws on unknown kind (fail-fast for typos)', async (t) => {
  try {
    formatErr('NOT_A_REAL_KIND', 'x')
    t.fail('should have thrown')
  } catch (err) {
    t.ok(err.message.includes('unknown error prefix kind'))
  }
})

test('classifyErr identifies known prefixes', async (t) => {
  t.is(classifyErr('auth-required: please sign in'), 'AUTH_REQUIRED')
  t.is(classifyErr('payment-required: 100 sats'), 'PAYMENT_REQUIRED')
  t.is(classifyErr('accept-mode-queued: awaiting operator'), 'ACCEPT_QUEUED')
  t.is(classifyErr('delegation-revoked: cert was burned'), 'DELEGATION_REVOKED')
})

test('classifyErr returns null for unknown prefixes', async (t) => {
  t.is(classifyErr('random error text'), null)
  t.is(classifyErr(''), null)
  t.is(classifyErr(null), null)
  t.is(classifyErr(undefined), null)
})

test('classifyErr accepts Error objects (reads .message)', async (t) => {
  const err = new Error('rate-limited: slow down')
  t.is(classifyErr(err), 'RATE_LIMITED')
})

test('isErr is a convenient boolean check', async (t) => {
  t.ok(isErr('auth-required: x', 'AUTH_REQUIRED'))
  t.absent(isErr('auth-required: x', 'PAYMENT_REQUIRED'))
  t.ok(isErr(new Error('not-found: missing'), 'NOT_FOUND'))
  t.absent(isErr('random text', 'AUTH_REQUIRED'))
})

test('isErr returns false for unknown kind rather than throwing', async (t) => {
  t.absent(isErr('auth-required: x', 'NOT_A_THING'))
})

test('every prefix is colon-space-terminated and non-overlapping', async (t) => {
  // Enforce the invariant that clients can reliably startsWith-match. If
  // one prefix were a prefix-of-another, classifyErr might pick the wrong
  // one when iterating.
  const prefixes = Object.values(ERR)
  for (const p of prefixes) {
    t.ok(p.endsWith(': '), p + ' must end with ": "')
  }
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = 0; j < prefixes.length; j++) {
      if (i === j) continue
      t.absent(prefixes[i].startsWith(prefixes[j]),
        prefixes[i] + ' must not start with ' + prefixes[j])
    }
  }
})
