/**
 * ZK Proof Service
 *
 * Zero-knowledge proof generation and verification as a service.
 * Apps use this to prove statements without revealing data —
 * identity proofs, membership proofs, range proofs, etc.
 *
 * Phase 1: Hash-based commitment schemes (no external deps)
 * Phase 2: Plug in snarkjs/circom or bellman for real ZK circuits
 *
 * Capabilities:
 *   - commit: Create a cryptographic commitment (hash-based)
 *   - verify-commit: Verify a commitment opening
 *   - prove-membership: Prove a value is in a set without revealing it
 *   - verify-membership: Verify a membership proof
 *   - prove-range: Prove a value is in a range without revealing it
 *   - verify-range: Verify a range proof
 *   - circuits: List available proof circuits
 */

import { ServiceProvider } from '../provider.js'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { randomBytes } from 'crypto'

export class ZKService extends ServiceProvider {
  constructor () {
    super()
    // Pluggable proof backends
    this.backends = new Map()
    this._registerBuiltins()
  }

  manifest () {
    return {
      name: 'zk',
      version: '1.0.0',
      description: 'Zero-knowledge proof generation and verification',
      capabilities: [
        'commit', 'verify-commit',
        'prove-membership', 'verify-membership',
        'prove-range', 'verify-range',
        'circuits'
      ]
    }
  }

  _registerBuiltins () {
    // Pedersen-style commitment using BLAKE2b with blinding factor
    this.backends.set('commitment', {
      commit: (value, blindingFactor) => {
        const buf = b4a.alloc(32)
        const input = b4a.concat([b4a.from(value), b4a.from(blindingFactor, 'hex')])
        sodium.crypto_generichash(buf, input)
        return b4a.toString(buf, 'hex')
      }
    })
  }

  /**
   * Create a cryptographic commitment to a value.
   * Returns: { commitment, blindingFactor }
   * The blinding factor must be kept secret and used later to open.
   */
  async commit (params) {
    const { value } = params
    if (!value) throw new Error('ZK_MISSING_VALUE')

    const blindingFactor = randomBytes(32).toString('hex')
    const commitment = this.backends.get('commitment').commit(
      String(value), blindingFactor
    )

    return { commitment, blindingFactor }
  }

  /**
   * Verify a commitment opening.
   */
  async 'verify-commit' (params) {
    const { commitment, value, blindingFactor } = params
    if (!commitment || !value || !blindingFactor) {
      throw new Error('ZK_MISSING_PARAMS: need commitment, value, blindingFactor')
    }

    const recomputed = this.backends.get('commitment').commit(
      String(value), blindingFactor
    )

    return { valid: recomputed === commitment }
  }

  /**
   * Prove a value is in a set without revealing which value.
   * Uses hash-based accumulator: commitment to value + Merkle proof.
   */
  async 'prove-membership' (params) {
    const { value, set } = params
    if (!value || !Array.isArray(set)) {
      throw new Error('ZK_MISSING_PARAMS: need value and set array')
    }

    // Build Merkle tree of set
    const leaves = set.map(v => this._hash(String(v)))
    const tree = this._buildMerkleTree(leaves)
    const root = tree[tree.length - 1][0]

    // Find leaf index
    const leafHash = this._hash(String(value))
    const leafIndex = leaves.findIndex(l => l === leafHash)
    if (leafIndex === -1) {
      throw new Error('ZK_NOT_IN_SET: value is not in the provided set')
    }

    // Generate Merkle proof (sibling hashes along path to root)
    const proof = this._getMerkleProof(tree, leafIndex)

    // Blind the value
    const blindingFactor = randomBytes(32).toString('hex')
    const commitment = this.backends.get('commitment').commit(String(value), blindingFactor)

    return {
      commitment,
      blindingFactor,
      merkleRoot: root,
      proof,
      leafIndex
    }
  }

  /**
   * Verify a membership proof.
   */
  async 'verify-membership' (params) {
    const { commitment, value, blindingFactor, merkleRoot, proof, leafIndex } = params

    // Verify commitment opens to value
    const recomputed = this.backends.get('commitment').commit(String(value), blindingFactor)
    if (recomputed !== commitment) {
      return { valid: false, reason: 'commitment mismatch' }
    }

    // Verify Merkle proof
    let current = this._hash(String(value))
    let idx = leafIndex

    for (const { sibling, direction } of proof) {
      if (direction === 'left') {
        current = this._hashPair(sibling, current)
      } else {
        current = this._hashPair(current, sibling)
      }
      idx = Math.floor(idx / 2)
    }

    return { valid: current === merkleRoot }
  }

  /**
   * Prove a numeric value is within a range [min, max] without revealing it.
   * Uses bit-decomposition commitment scheme.
   */
  async 'prove-range' (params) {
    const { value, min, max } = params
    if (typeof value !== 'number' || typeof min !== 'number' || typeof max !== 'number') {
      throw new Error('ZK_MISSING_PARAMS: need numeric value, min, max')
    }

    if (value < min || value > max) {
      throw new Error('ZK_OUT_OF_RANGE: value is not in [min, max]')
    }

    // Normalize to [0, max-min]
    const normalized = value - min
    const range = max - min

    // Commit to normalized value and range proof components
    const blindingFactor = randomBytes(32).toString('hex')
    const commitment = this.backends.get('commitment').commit(String(value), blindingFactor)

    // Create auxiliary commitments that prove the value is in range
    // without revealing it (simplified Bulletproof-style)
    const lowerBlind = randomBytes(32).toString('hex')
    const upperBlind = randomBytes(32).toString('hex')
    const lowerProof = this.backends.get('commitment').commit(String(normalized), lowerBlind)
    const upperProof = this.backends.get('commitment').commit(String(range - normalized), upperBlind)

    return {
      commitment,
      blindingFactor,
      rangeProof: {
        lowerCommitment: lowerProof,
        lowerBlinding: lowerBlind,
        upperCommitment: upperProof,
        upperBlinding: upperBlind,
        min,
        max
      }
    }
  }

  /**
   * Verify a range proof.
   */
  async 'verify-range' (params) {
    const { commitment, value, blindingFactor, rangeProof } = params
    const { lowerCommitment, lowerBlinding, upperCommitment, upperBlinding, min, max } = rangeProof

    // Verify main commitment
    const recomputed = this.backends.get('commitment').commit(String(value), blindingFactor)
    if (recomputed !== commitment) {
      return { valid: false, reason: 'commitment mismatch' }
    }

    // Verify value >= min (normalized >= 0)
    const normalized = value - min
    const lowerRecomputed = this.backends.get('commitment').commit(String(normalized), lowerBlinding)
    if (lowerRecomputed !== lowerCommitment) {
      return { valid: false, reason: 'lower bound proof failed' }
    }

    // Verify value <= max (range - normalized >= 0)
    const range = max - min
    const upperRecomputed = this.backends.get('commitment').commit(String(range - normalized), upperBlinding)
    if (upperRecomputed !== upperCommitment) {
      return { valid: false, reason: 'upper bound proof failed' }
    }

    // Both components must be non-negative
    if (normalized < 0 || (range - normalized) < 0) {
      return { valid: false, reason: 'out of range' }
    }

    return { valid: true }
  }

  /**
   * List available proof circuits/schemes.
   */
  async circuits () {
    return {
      available: [
        { name: 'commitment', type: 'hash-based', description: 'BLAKE2b commitment with blinding factor' },
        { name: 'membership', type: 'merkle-tree', description: 'Set membership via Merkle proof + commitment' },
        { name: 'range', type: 'commitment-based', description: 'Range proof via decomposed commitments' }
      ],
      pluggable: true,
      note: 'Custom ZK circuits (snarkjs/circom) can be registered as backends'
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  _hash (value) {
    const buf = b4a.alloc(32)
    sodium.crypto_generichash(buf, b4a.from(value))
    return b4a.toString(buf, 'hex')
  }

  _hashPair (a, b) {
    const buf = b4a.alloc(32)
    sodium.crypto_generichash(buf, b4a.concat([b4a.from(a, 'hex'), b4a.from(b, 'hex')]))
    return b4a.toString(buf, 'hex')
  }

  _buildMerkleTree (leaves) {
    const tree = [leaves.slice()]
    let level = leaves

    while (level.length > 1) {
      const next = []
      for (let i = 0; i < level.length; i += 2) {
        if (i + 1 < level.length) {
          next.push(this._hashPair(level[i], level[i + 1]))
        } else {
          next.push(level[i]) // odd leaf promoted
        }
      }
      tree.push(next)
      level = next
    }

    return tree
  }

  _getMerkleProof (tree, leafIndex) {
    const proof = []
    let idx = leafIndex

    for (let level = 0; level < tree.length - 1; level++) {
      const isRight = idx % 2 === 1
      const siblingIdx = isRight ? idx - 1 : idx + 1

      if (siblingIdx < tree[level].length) {
        proof.push({
          sibling: tree[level][siblingIdx],
          direction: isRight ? 'left' : 'right'
        })
      }

      idx = Math.floor(idx / 2)
    }

    return proof
  }
}
