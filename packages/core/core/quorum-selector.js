/**
 * QuorumSelector — picks geographically + organizationally diverse
 * relays for a client's read quorum.
 *
 * Implements the threat-model defense mechanism #1 (replica diversity):
 * if a client only ever talks to one relay (or to N relays controlled
 * by the same operator in the same datacenter), an attacker who
 * controls that single point can feed a consistent lie unbounded.
 * Diverse-quorum selection forces an attacker to compromise
 * geographically + organizationally separate parties simultaneously,
 * which is strictly more expensive.
 *
 * Strategies:
 *   'diverse'    — default. Picks relays maximizing distinct (region,
 *                  operator_pubkey) tuples. Falls back to whatever's
 *                  available if there isn't enough diversity in the
 *                  candidate set.
 *   'foundation' — uses a hardcoded list of foundation-network pubkeys
 *                  (the operator-of-last-resort guarantee). Useful for
 *                  apps that need a known-trusted floor.
 *   'pinned'     — uses an explicit list the caller passes in. No
 *                  diversity check; caller takes responsibility.
 *   'wide'       — uses up to N relays with no diversity constraint.
 *                  Useful for high-traffic apps that want maximum
 *                  parallelism over consistency.
 *
 * Inputs to the selector are RelayInfo records — typically obtained by
 * fetching /.well-known/hiverelay.json from candidate relays
 * (advertised via the swarm's discovery topic). The capability doc
 * gives us pubkey + region + features, which is exactly what we need.
 *
 * Pure functions, no I/O, no module-level state. The HiveRelayClient
 * does the network fetches and feeds RelayInfo into select().
 */

const VALID_STRATEGIES = ['diverse', 'foundation', 'pinned', 'wide']
const DEFAULT_QUORUM_SIZE = 5
const DEFAULT_MIN_REGIONS = 3

/**
 * @typedef {object} RelayInfo
 * @property {string} pubkey         relay's identity public key (hex)
 * @property {string} [region]       e.g. 'us-east-1', 'eu-west', 'asia-tokyo'
 * @property {string} [operator]     operator-controlled pubkey if distinct
 *                                   from `pubkey` (multi-relay operators)
 * @property {string[]} [features]   feature flags advertised in capability doc
 * @property {number}   [latencyMs]  observed RTT (optional; informs ranking)
 * @property {number}   [score]      operator-score (0-1 normalized; optional)
 */

/**
 * Pick a diverse quorum from a candidate set.
 *
 * @param {RelayInfo[]} candidates  - all relays we know about
 * @param {object} [opts]
 * @param {string}   [opts.strategy='diverse']
 * @param {number}   [opts.size=5]                    target quorum size
 * @param {number}   [opts.minRegions=3]              minimum distinct regions
 * @param {string[]} [opts.foundationPubkeys=[]]      hardcoded foundation-network pubkeys
 * @param {string[]} [opts.pinnedPubkeys=[]]          explicit relay list (for 'pinned' strategy)
 * @param {string[]} [opts.requireFeatures=[]]        only consider relays advertising these
 *
 * @returns {RelayInfo[]} ordered list of selected relays (best first)
 */
export function selectQuorum (candidates, opts = {}) {
  const strategy = opts.strategy || 'diverse'
  if (!VALID_STRATEGIES.includes(strategy)) {
    throw new Error('Unknown quorum strategy: ' + strategy)
  }
  const size = opts.size || DEFAULT_QUORUM_SIZE
  const requireFeatures = opts.requireFeatures || []

  // Filter to candidates with the required feature set. A relay missing
  // a required feature can't fulfill the query at all — there's no
  // point including it in the quorum.
  let pool = (candidates || []).filter(c => c && typeof c.pubkey === 'string')
  if (requireFeatures.length > 0) {
    pool = pool.filter(c => {
      const features = Array.isArray(c.features) ? c.features : []
      return requireFeatures.every(f => features.includes(f))
    })
  }

  switch (strategy) {
    case 'pinned':
      return selectPinned(pool, opts.pinnedPubkeys || [], size)
    case 'foundation':
      return selectFoundation(pool, opts.foundationPubkeys || [], size)
    case 'wide':
      return selectWide(pool, size)
    case 'diverse':
    default:
      return selectDiverse(pool, size, opts.minRegions || DEFAULT_MIN_REGIONS)
  }
}

/**
 * Diverse strategy — maximize distinct (region, operator) tuples.
 *
 * Greedy: walk the candidate pool sorted by score (descending) and
 * include a candidate only if it adds a new region OR a new operator
 * the current selection doesn't already have. Once we have at least
 * `minRegions` distinct regions AND `size` relays, stop.
 *
 * If we exhaust diverse options before hitting `size`, fall back to
 * the highest-scoring remaining candidates regardless of diversity —
 * we want SOMETHING served over nothing.
 */
function selectDiverse (pool, size, minRegions) {
  const ranked = [...pool].sort(byScoreDesc)
  const selected = []
  const seenRegions = new Set()
  const seenOperators = new Set()

  // Pass 1 — diverse picks
  for (const r of ranked) {
    if (selected.length >= size) break
    const region = r.region || '__unknown__'
    const op = r.operator || r.pubkey
    const newRegion = !seenRegions.has(region)
    const newOperator = !seenOperators.has(op)
    if (newRegion || newOperator) {
      selected.push(r)
      seenRegions.add(region)
      seenOperators.add(op)
    }
  }

  // Pass 2 — fill remaining slots with highest-scoring candidates we
  // haven't already taken, even if not diverse.
  if (selected.length < size) {
    const taken = new Set(selected.map(r => r.pubkey))
    for (const r of ranked) {
      if (selected.length >= size) break
      if (taken.has(r.pubkey)) continue
      selected.push(r)
    }
  }

  // If we couldn't reach minRegions, the caller should know — emit a
  // diversity_warning by attaching it to the result. The HiveRelayClient
  // surfaces this as a 'quorum-warning' event so apps can decide whether
  // to wait for more candidates or proceed.
  if (seenRegions.size < minRegions && selected.length > 0) {
    selected.diversityWarning = {
      reason: 'insufficient-region-diversity',
      observedRegions: seenRegions.size,
      requiredRegions: minRegions
    }
  }

  return selected
}

/**
 * Foundation strategy — restrict to a hardcoded set of trusted relay
 * pubkeys (the operator-of-last-resort layer).
 */
function selectFoundation (pool, foundationPubkeys, size) {
  const wanted = new Set(foundationPubkeys.map(p => p.toLowerCase()))
  const matched = pool
    .filter(c => wanted.has(c.pubkey.toLowerCase()))
    .sort(byScoreDesc)
  return matched.slice(0, size)
}

/**
 * Pinned strategy — exact pubkey list. Caller takes full responsibility.
 */
function selectPinned (pool, pinnedPubkeys, size) {
  const wanted = pinnedPubkeys.map(p => p.toLowerCase())
  // Preserve caller-supplied order so dependent infra can rely on it.
  const matched = []
  for (const wantedPub of wanted) {
    const found = pool.find(c => c.pubkey.toLowerCase() === wantedPub)
    if (found) matched.push(found)
    if (matched.length >= size) break
  }
  return matched
}

/**
 * Wide strategy — best-N regardless of diversity.
 */
function selectWide (pool, size) {
  return [...pool].sort(byScoreDesc).slice(0, size)
}

/**
 * Default ranking: higher operator-score first; tiebreak by lower
 * latency. Both fields are optional — relays advertising neither rank
 * deterministically by pubkey for stability across runs.
 */
function byScoreDesc (a, b) {
  const sa = typeof a.score === 'number' ? a.score : 0
  const sb = typeof b.score === 'number' ? b.score : 0
  if (sb !== sa) return sb - sa
  const la = typeof a.latencyMs === 'number' ? a.latencyMs : Infinity
  const lb = typeof b.latencyMs === 'number' ? b.latencyMs : Infinity
  if (la !== lb) return la - lb
  return a.pubkey.localeCompare(b.pubkey)
}

/**
 * Lightweight summary of a quorum selection — used by client UIs and
 * the diagnostics dashboard to explain why a particular set was chosen.
 */
export function describeQuorum (selected) {
  if (!Array.isArray(selected) || selected.length === 0) {
    return { size: 0, regions: [], operators: [], warning: null }
  }
  const regions = [...new Set(selected.map(r => r.region || '__unknown__'))]
  const operators = [...new Set(selected.map(r => r.operator || r.pubkey))]
  return {
    size: selected.length,
    regions,
    operators,
    warning: selected.diversityWarning || null
  }
}

export {
  VALID_STRATEGIES,
  DEFAULT_QUORUM_SIZE,
  DEFAULT_MIN_REGIONS
}
