/**
 * Catalog accept-mode helpers — shared by the Node RelayNode and the
 * Bare/Pear BareRelay. Pure functions, no I/O, no module-level state.
 *
 * Modes:
 *   'open'      — auto-accept every signed seed request
 *   'review'    — queue for operator approval
 *   'allowlist' — auto-accept only when publisher is on acceptAllowlist
 *   'closed'    — reject all inbound seed requests
 *
 * Bare/Pear runtimes have no operator TUI to drain a review queue, so the
 * BareRelay caller can decide to coerce 'review' → 'closed' on its end.
 */

const VALID_MODES = ['open', 'review', 'allowlist', 'closed']

/**
 * Resolve the accept mode from a config object. Honors deprecated
 * `registryAutoAccept` boolean as an alias.
 *
 * @param {object} config
 * @returns {'open'|'review'|'allowlist'|'closed'}
 */
export function resolveAcceptMode (config = {}) {
  const m = config.acceptMode
  if (VALID_MODES.includes(m)) return m
  if (config.registryAutoAccept === false) return 'review'
  if (config.registryAutoAccept === true) return 'open'
  return 'review' // safe default
}

/**
 * Decide the disposition for one seed request given the current mode and
 * (optionally) an allowlist of publisher pubkeys (hex).
 *
 * @param {{publisherPubkey?: string|Buffer|null}} req
 * @param {'open'|'review'|'allowlist'|'closed'} mode
 * @param {string[]} [allowlist]
 * @returns {'accept'|'queue'|'reject'}
 */
export function decideAcceptance (req, mode, allowlist = []) {
  if (mode === 'closed') return 'reject'
  if (mode === 'open') return 'accept'
  if (mode === 'allowlist') {
    const publisher = normalizeHex(req && req.publisherPubkey)
    return publisher && allowlist.includes(publisher) ? 'accept' : 'reject'
  }
  return 'queue' // 'review'
}

function normalizeHex (val) {
  if (!val) return null
  if (typeof val === 'string') return val
  // Buffer / Uint8Array — convert to hex without pulling in b4a here so this
  // file stays dependency-free and importable from both runtimes.
  if (val.toString && typeof val.toString === 'function') {
    try {
      const hex = val.toString('hex')
      if (hex && /^[0-9a-f]+$/i.test(hex)) return hex
    } catch (_) {}
  }
  return null
}
