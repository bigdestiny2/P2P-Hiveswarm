import test from 'brittle'
import {
  selectQuorum,
  describeQuorum,
  VALID_STRATEGIES,
  DEFAULT_QUORUM_SIZE,
  DEFAULT_MIN_REGIONS
} from 'p2p-hiverelay/core/quorum-selector.js'

// Helper — build a synthetic candidate list
function r (pubkey, region, operator, opts = {}) {
  return {
    pubkey,
    region,
    operator: operator || pubkey,
    features: opts.features || [],
    latencyMs: opts.latencyMs,
    score: opts.score
  }
}

const sampleCandidates = [
  r('aa', 'us-east-1', 'opA', { score: 0.9, latencyMs: 30 }),
  r('bb', 'us-east-1', 'opA', { score: 0.85, latencyMs: 20 }), // same op as aa
  r('cc', 'eu-west', 'opB', { score: 0.8 }),
  r('dd', 'asia-tokyo', 'opC', { score: 0.7 }),
  r('ee', 'sa-east', 'opD', { score: 0.6 }),
  r('ff', 'us-west', 'opA', { score: 0.55 }), // same op as aa+bb, new region
  r('gg', 'me-uae', 'opE', { score: 0.5 })
]

test('exports expected strategies and defaults', async (t) => {
  t.alike([...VALID_STRATEGIES].sort(), ['diverse', 'foundation', 'pinned', 'wide'])
  t.is(DEFAULT_QUORUM_SIZE, 5)
  t.is(DEFAULT_MIN_REGIONS, 3)
})

test('throws on unknown strategy', async (t) => {
  try {
    selectQuorum(sampleCandidates, { strategy: 'mystery' })
    t.fail('should throw')
  } catch (err) {
    t.ok(err.message.includes('Unknown quorum strategy'))
  }
})

test('diverse strategy maximizes distinct (region, operator) tuples', async (t) => {
  const selected = selectQuorum(sampleCandidates, { strategy: 'diverse', size: 5 })
  t.is(selected.length, 5)
  const regions = new Set(selected.map(s => s.region))
  const operators = new Set(selected.map(s => s.operator))
  t.ok(regions.size >= 4, 'should hit at least 4 distinct regions')
  t.ok(operators.size >= 4, 'should hit at least 4 distinct operators')
})

test('diverse strategy attaches warning when minRegions not met', async (t) => {
  // Force a low-diversity candidate set
  const monoRegion = [
    r('aa', 'us-east-1', 'opA', { score: 0.9 }),
    r('bb', 'us-east-1', 'opB', { score: 0.85 }),
    r('cc', 'us-east-1', 'opC', { score: 0.8 })
  ]
  const selected = selectQuorum(monoRegion, { strategy: 'diverse', size: 3, minRegions: 3 })
  t.ok(selected.diversityWarning, 'warning should be attached')
  t.is(selected.diversityWarning.observedRegions, 1)
  t.is(selected.diversityWarning.requiredRegions, 3)
})

test('diverse strategy fills with non-diverse picks if pool is small', async (t) => {
  // Only 3 candidates, asked for 5 — should still return 3
  const tiny = sampleCandidates.slice(0, 3)
  const selected = selectQuorum(tiny, { strategy: 'diverse', size: 5 })
  t.is(selected.length, 3)
})

test('diverse strategy ranks by score then latency then pubkey for stability', async (t) => {
  const ranked = selectQuorum(sampleCandidates, { strategy: 'diverse', size: 7 })
  // Highest scorer (aa @ 0.9) should appear first
  t.is(ranked[0].pubkey, 'aa')
})

test('foundation strategy restricts to specified pubkeys', async (t) => {
  const selected = selectQuorum(sampleCandidates, {
    strategy: 'foundation',
    foundationPubkeys: ['cc', 'dd', 'gg'],
    size: 5
  })
  t.is(selected.length, 3)
  t.alike(selected.map(s => s.pubkey).sort(), ['cc', 'dd', 'gg'])
})

test('foundation strategy is case-insensitive on pubkey matching', async (t) => {
  const selected = selectQuorum(sampleCandidates, {
    strategy: 'foundation',
    foundationPubkeys: ['CC', 'Dd'],
    size: 5
  })
  t.is(selected.length, 2)
})

test('pinned strategy preserves caller-supplied order', async (t) => {
  const selected = selectQuorum(sampleCandidates, {
    strategy: 'pinned',
    pinnedPubkeys: ['gg', 'aa', 'cc'],
    size: 5
  })
  t.alike(selected.map(s => s.pubkey), ['gg', 'aa', 'cc'])
})

test('pinned strategy honors size cap', async (t) => {
  const selected = selectQuorum(sampleCandidates, {
    strategy: 'pinned',
    pinnedPubkeys: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'],
    size: 3
  })
  t.is(selected.length, 3)
})

test('wide strategy returns top-N by score regardless of diversity', async (t) => {
  const selected = selectQuorum(sampleCandidates, { strategy: 'wide', size: 4 })
  t.is(selected.length, 4)
  t.alike(selected.map(s => s.pubkey), ['aa', 'bb', 'cc', 'dd'])
})

test('requireFeatures filters out relays missing required capabilities', async (t) => {
  const candidates = [
    r('aa', 'us-east-1', 'opA', { score: 0.9, features: ['payment-required', 'ai-inference'] }),
    r('bb', 'eu-west', 'opB', { score: 0.85, features: ['payment-required'] }),
    r('cc', 'asia-tokyo', 'opC', { score: 0.8, features: ['ai-inference'] })
  ]
  const selected = selectQuorum(candidates, {
    strategy: 'diverse',
    size: 5,
    requireFeatures: ['payment-required']
  })
  t.is(selected.length, 2)
  t.ok(selected.every(s => s.features.includes('payment-required')))
})

test('handles empty candidate pool gracefully', async (t) => {
  const selected = selectQuorum([], { strategy: 'diverse' })
  t.is(selected.length, 0)
})

test('handles null/undefined candidate entries', async (t) => {
  const messy = [null, undefined, r('aa', 'us-east-1', 'opA', { score: 0.9 }), { not: 'a real entry' }]
  const selected = selectQuorum(messy, { strategy: 'diverse', size: 5 })
  t.is(selected.length, 1)
  t.is(selected[0].pubkey, 'aa')
})

test('describeQuorum summarizes selection clearly', async (t) => {
  const selected = selectQuorum(sampleCandidates, { strategy: 'diverse', size: 5 })
  const desc = describeQuorum(selected)
  t.is(desc.size, 5)
  t.ok(desc.regions.length >= 4)
  t.ok(desc.operators.length >= 4)
  t.is(desc.warning, null)
})

test('describeQuorum surfaces diversity warning', async (t) => {
  const monoRegion = [
    r('aa', 'us-east-1', 'opA', { score: 0.9 }),
    r('bb', 'us-east-1', 'opB', { score: 0.85 })
  ]
  const selected = selectQuorum(monoRegion, { strategy: 'diverse', size: 2, minRegions: 3 })
  const desc = describeQuorum(selected)
  t.ok(desc.warning)
  t.is(desc.warning.reason, 'insufficient-region-diversity')
})

test('describeQuorum on empty selection returns size 0', async (t) => {
  const desc = describeQuorum([])
  t.is(desc.size, 0)
  t.is(desc.regions.length, 0)
})

test('relays missing region are bucketed as __unknown__', async (t) => {
  const noRegion = [
    r('aa', undefined, 'opA', { score: 0.9 }),
    r('bb', undefined, 'opB', { score: 0.85 })
  ]
  const selected = selectQuorum(noRegion, { strategy: 'diverse', size: 2, minRegions: 3 })
  // Should still select both (different operators count as diversity)
  t.is(selected.length, 2)
})
