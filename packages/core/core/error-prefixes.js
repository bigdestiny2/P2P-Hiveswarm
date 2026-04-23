/**
 * Machine-readable error prefixes.
 *
 * Client error strings have historically been ad-hoc ('bad request',
 * 'not allowed', 'access denied', 'cert invalid'). Clients that wanted to
 * distinguish "retry after auth" from "permanently rejected" had to
 * string-match substrings, which is fragile and locale-sensitive.
 *
 * Each error message carries a stable machine-parseable prefix of the form
 * `<kind>: <human message>`. Prefixes are kebab-case-ish (hyphenated),
 * colon-and-space-terminated, and MUST be stable across versions — we add
 * new prefixes, we do not remove or rename existing ones.
 *
 * Client usage:
 *
 *   try { await client.publish(...) }
 *   catch (err) {
 *     if (err.message.startsWith(ERR.AUTH_REQUIRED)) { await signIn(); retry() }
 *     else if (err.message.startsWith(ERR.ACCEPT_QUEUED)) { showPendingUI() }
 *     else throw err
 *   }
 *
 * Rules for adding a new prefix:
 *   - Must be a distinct disposition (not just a different reason for an
 *     existing one). Reason detail goes in the human message after the colon.
 *   - Must survive a version bump — we do not remove prefixes, only add.
 *   - kebab-case-ish (hyphenated). No trailing colon in the constant, we add
 *     it in formatErr() / the helpers.
 */

const PREFIXES = Object.freeze({
  AUTH_REQUIRED: 'auth-required: ',
  PAYMENT_REQUIRED: 'payment-required: ',
  ACCEPT_QUEUED: 'accept-mode-queued: ',
  ACCEPT_REJECTED: 'accept-mode-rejected: ',
  DELEGATION_INVALID: 'delegation-invalid: ',
  DELEGATION_REVOKED: 'delegation-revoked: ',
  DELEGATION_EXPIRED: 'delegation-expired: ',
  RATE_LIMITED: 'rate-limited: ',
  NOT_ALLOWED: 'not-allowed: ',
  NOT_FOUND: 'not-found: ',
  BAD_REQUEST: 'bad-request: ',
  UNSUPPORTED: 'unsupported: '
})

/**
 * Format an error message with a prefix.
 *
 *   formatErr('AUTH_REQUIRED', 'sign in first')  // → 'auth-required: sign in first'
 *
 * @param {keyof typeof PREFIXES} kind
 * @param {string} [message]
 * @returns {string}
 */
function formatErr (kind, message = '') {
  const prefix = PREFIXES[kind]
  if (!prefix) throw new Error('unknown error prefix kind: ' + kind)
  return prefix + (message || '').trim()
}

/**
 * Classify an error message by its prefix. Returns the prefix KEY (e.g.
 * 'AUTH_REQUIRED') or null if no known prefix matches.
 *
 * @param {string|Error} err
 * @returns {string|null}
 */
function classifyErr (err) {
  const msg = err && typeof err === 'object' ? (err.message || '') : String(err || '')
  for (const [key, prefix] of Object.entries(PREFIXES)) {
    if (msg.startsWith(prefix)) return key
  }
  return null
}

/**
 * True if `err`'s message starts with the given prefix kind.
 *
 * @param {string|Error} err
 * @param {keyof typeof PREFIXES} kind
 * @returns {boolean}
 */
function isErr (err, kind) {
  const prefix = PREFIXES[kind]
  if (!prefix) return false
  const msg = err && typeof err === 'object' ? (err.message || '') : String(err || '')
  return msg.startsWith(prefix)
}

export { PREFIXES as ERR, formatErr, classifyErr, isErr }
