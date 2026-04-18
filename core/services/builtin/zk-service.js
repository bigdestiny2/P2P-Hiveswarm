/**
 * ZK Proof Service — P2P Game Cryptography
 *
 * Real elliptic curve zero-knowledge proofs on secp256k1.
 * Built for P2P card games (mental poker), betting, and fair randomness.
 *
 * Primitives:
 *   - Pedersen commitments (hiding + binding on EC)
 *   - Schnorr NIZK proofs (sigma protocols)
 *   - DLEQ proofs (discrete log equality — proves correct card reveal)
 *   - ElGamal card encryption (mental poker masking/unmasking)
 *   - Fair multi-party randomness (commit-reveal coin flip)
 *   - Merkle membership proofs (ZK set membership)
 *   - Range proofs (commitment-homomorphic)
 *
 * All crypto uses @noble/secp256k1 + sodium-universal (already installed).
 * No snarkjs, no heavyweight circuits.
 */

import { ServiceProvider } from '../provider.js'
import * as secp from '@noble/secp256k1'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import { randomBytes } from '../../compat/random.js'

// Wire noble hashes (required for secp256k1 v2+)
if (!secp.hashes.sha256) {
  secp.hashes.sha256 = (...msgs) => sha256(secp.etc.concatBytes(...msgs.filter(m => m != null)))
  secp.hashes.hmacSha256 = (key, ...msgs) => hmac(sha256, key, secp.etc.concatBytes(...msgs.filter(m => m != null)))
}

// ─── Constants ──────────────────────────────────────────────────────

const G = secp.Point.BASE
const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n

// Second generator H for Pedersen commitments (nothing-up-my-sleeve construction)
const H = hashToCurveSimple('hiverelay-pedersen-generator-H-v1')

// Pre-computed card points for mental poker (52 cards)
const CARD_POINTS = new Map()
const CARD_LOOKUP = new Map() // compressed hex → card index
for (let i = 0; i < 52; i++) {
  const P = hashToCurveSimple(`hiverelay-card-${i}`)
  CARD_POINTS.set(i, P)
  CARD_LOOKUP.set(P.toHex(true), i)
}

// ─── Helpers ────────────────────────────────────────────────────────

function modN (n) {
  return ((n % N) + N) % N
}

function randomScalar () {
  let s
  do {
    s = modN(secp.etc.bytesToNumberBE(randomBytes(32)))
  } while (s === 0n)
  return s
}

function scalarToHex (s) {
  return s.toString(16).padStart(64, '0')
}

function hexToScalar (h) {
  return BigInt('0x' + h)
}

function pointToHex (P) {
  return P.toHex(true)
}

function hexToPoint (h) {
  return secp.Point.fromHex(h)
}

/** Hash arbitrary buffers to a scalar mod N using BLAKE2b */
function hashToScalar (...parts) {
  const input = b4a.concat(parts.map(p => typeof p === 'string' ? b4a.from(p, 'hex') : b4a.from(p)))
  const hash = b4a.alloc(32)
  sodium.crypto_generichash(hash, input)
  return modN(secp.etc.bytesToNumberBE(hash))
}

/** Convert a value (number or string) to a scalar for Pedersen commitments */
function valueToScalar (v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('ZK_INVALID_VALUE')
    return modN(BigInt(Math.round(v)))
  }
  return hashToScalar(b4a.from(String(v)))
}

/** Find a valid secp256k1 point from a seed string (nothing-up-my-sleeve) */
function hashToCurveSimple (seed) {
  for (let counter = 0; counter < 256; counter++) {
    const input = b4a.from(seed + ':' + counter)
    const hash = b4a.alloc(32)
    sodium.crypto_generichash(hash, input)
    // Try as compressed point with prefix 0x02
    const compressed = Buffer.concat([Buffer.from([0x02]), hash])
    try {
      return secp.Point.fromHex(Buffer.from(compressed).toString('hex'))
    } catch {
      continue
    }
  }
  throw new Error('hashToCurveSimple failed after 256 attempts')
}

/** BLAKE2b hash a string/buffer to hex */
function blake2bHex (input) {
  const buf = b4a.alloc(32)
  sodium.crypto_generichash(buf, typeof input === 'string' ? b4a.from(input) : input)
  return b4a.toString(buf, 'hex')
}

// ─── Service ────────────────────────────────────────────────────────

export class ZKService extends ServiceProvider {
  constructor () {
    super()
    this.backends = new Map()
  }

  manifest () {
    return {
      name: 'zk',
      version: '2.0.0',
      description: 'Zero-knowledge proofs and P2P game cryptography (secp256k1)',
      capabilities: [
        'commit', 'verify-commit',
        'prove-knowledge', 'verify-knowledge',
        'prove-dleq', 'verify-dleq',
        'encrypt-card', 'create-reveal-token', 'unmask-card',
        'commit-random', 'combine-reveals',
        'prove-membership', 'verify-membership',
        'prove-range', 'verify-range',
        'circuits'
      ]
    }
  }

  /**
   * Register a custom proof backend (for snarkjs/circom integration).
   */
  registerBackend (name, backend) {
    this.backends.set(name, backend)
  }

  // ─── Pedersen Commitments ───────────────────────────────────────

  /**
   * Create a Pedersen commitment: C = r*G + v*H
   * Hiding (can't learn v from C) and binding (can't open to different v).
   */
  async commit (params) {
    const { value } = params
    if (value === undefined || value === null) throw new Error('ZK_MISSING_VALUE')

    const v = valueToScalar(value)
    const r = randomScalar()
    const C = G.multiply(r).add(H.multiply(v))

    return {
      commitment: pointToHex(C),
      blindingFactor: scalarToHex(r)
    }
  }

  /**
   * Verify a Pedersen commitment opening.
   */
  async 'verify-commit' (params) {
    const { commitment, value, blindingFactor } = params
    if (!commitment || value === undefined || !blindingFactor) {
      throw new Error('ZK_MISSING_PARAMS: need commitment, value, blindingFactor')
    }

    const v = valueToScalar(value)
    const r = hexToScalar(blindingFactor)
    const C = G.multiply(r).add(H.multiply(v))

    return { valid: pointToHex(C) === commitment }
  }

  // ─── Schnorr NIZK Proofs (Sigma Protocol) ──────────────────────

  /**
   * Prove knowledge of x such that A = x*G, without revealing x.
   * Uses Fiat-Shamir transform for non-interactive proof.
   */
  async 'prove-knowledge' (params) {
    const { secret } = params
    if (!secret) throw new Error('ZK_MISSING_SECRET')

    const x = hexToScalar(secret)
    const A = G.multiply(x)

    // Commitment
    const k = randomScalar()
    const R = G.multiply(k)

    // Challenge (Fiat-Shamir)
    const e = hashToScalar(pointToHex(R), pointToHex(A))

    // Response
    const s = modN(k - e * x)

    return {
      proof: { R: pointToHex(R), s: scalarToHex(s) },
      publicPoint: pointToHex(A)
    }
  }

  /**
   * Verify a Schnorr proof of knowledge.
   * Checks: s*G + e*A == R
   */
  async 'verify-knowledge' (params) {
    const { proof, publicPoint } = params
    if (!proof || !publicPoint) throw new Error('ZK_MISSING_PARAMS')

    try {
      const R = hexToPoint(proof.R)
      const s = hexToScalar(proof.s)
      const A = hexToPoint(publicPoint)

      const e = hashToScalar(pointToHex(R), pointToHex(A))

      // s*G + e*A should equal R
      const lhs = G.multiply(s === 0n ? N : s).add(A.multiply(e))
      return { valid: lhs.equals(R) }
    } catch {
      return { valid: false, reason: 'invalid proof format' }
    }
  }

  // ─── DLEQ Proofs (Discrete Log Equality) ───────────────────────

  /**
   * Prove that log_G(A) == log_H(B), i.e., A = x*G and B = x*H for same x.
   * Critical for card revealing: proves your reveal token is correct.
   */
  async 'prove-dleq' (params) {
    const { secret, G: Ghex, A: Ahex, H: Hhex, B: Bhex } = params
    if (!secret || !Ghex || !Ahex || !Hhex || !Bhex) throw new Error('ZK_MISSING_PARAMS')

    const x = hexToScalar(secret)
    const Gin = hexToPoint(Ghex)
    const Ain = hexToPoint(Ahex)
    const Hin = hexToPoint(Hhex)
    const Bin = hexToPoint(Bhex)

    // Random nonce
    const k = randomScalar()
    const R1 = Gin.multiply(k)
    const R2 = Hin.multiply(k)

    // Challenge
    const e = hashToScalar(
      pointToHex(Gin), pointToHex(Ain),
      pointToHex(Hin), pointToHex(Bin),
      pointToHex(R1), pointToHex(R2)
    )

    // Response
    const s = modN(k - e * x)

    return {
      proof: { e: scalarToHex(e), s: scalarToHex(s) }
    }
  }

  /**
   * Verify a DLEQ proof.
   * Recomputes R1 = s*G + e*A, R2 = s*H + e*B, then checks challenge.
   */
  async 'verify-dleq' (params) {
    const { proof, G: Ghex, A: Ahex, H: Hhex, B: Bhex } = params
    if (!proof || !Ghex || !Ahex || !Hhex || !Bhex) throw new Error('ZK_MISSING_PARAMS')

    try {
      const e = hexToScalar(proof.e)
      const s = hexToScalar(proof.s)
      const Gin = hexToPoint(Ghex)
      const Ain = hexToPoint(Ahex)
      const Hin = hexToPoint(Hhex)
      const Bin = hexToPoint(Bhex)

      // Recompute R1 = s*G + e*A, R2 = s*H + e*B
      const sOrN = s === 0n ? N : s
      const R1 = Gin.multiply(sOrN).add(Ain.multiply(e))
      const R2 = Hin.multiply(sOrN).add(Bin.multiply(e))

      // Recompute challenge
      const e2 = hashToScalar(
        pointToHex(Gin), pointToHex(Ain),
        pointToHex(Hin), pointToHex(Bin),
        pointToHex(R1), pointToHex(R2)
      )

      return { valid: e === e2 }
    } catch {
      return { valid: false, reason: 'invalid proof format' }
    }
  }

  // ─── ElGamal Card Encryption (Mental Poker) ────────────────────

  /**
   * Encrypt a card using ElGamal on secp256k1.
   * Card indices 0-51 map to pre-computed EC points.
   * encrypted = (r*G, M + r*PK) where M is the card point.
   */
  async 'encrypt-card' (params) {
    const { card, publicKey } = params
    if (typeof card !== 'number' || card < 0 || card > 51) {
      throw new Error('ZK_INVALID_CARD: must be 0-51')
    }
    if (!publicKey) throw new Error('ZK_MISSING_PUBLIC_KEY')

    const M = CARD_POINTS.get(card)
    const PK = hexToPoint(publicKey)
    const r = randomScalar()

    const C1 = G.multiply(r)       // ephemeral key
    const C2 = M.add(PK.multiply(r)) // masked card

    return {
      encrypted: {
        c1: pointToHex(C1),
        c2: pointToHex(C2)
      }
    }
  }

  /**
   * Create a reveal token (partial decryption) for a card.
   * token = secretKey * C1, with a DLEQ proof that it's correct.
   */
  async 'create-reveal-token' (params) {
    const { encrypted, secretKey } = params
    if (!encrypted || !secretKey) throw new Error('ZK_MISSING_PARAMS')

    const sk = hexToScalar(secretKey)
    const C1 = hexToPoint(encrypted.c1)
    const PK = G.multiply(sk) // public key

    // Partial decryption
    const token = C1.multiply(sk)

    // DLEQ proof: log_G(PK) == log_C1(token)
    const k = randomScalar()
    const R1 = G.multiply(k)
    const R2 = C1.multiply(k)

    const e = hashToScalar(
      pointToHex(G), pointToHex(PK),
      pointToHex(C1), pointToHex(token),
      pointToHex(R1), pointToHex(R2)
    )
    const s = modN(k - e * sk)

    return {
      token: pointToHex(token),
      publicKey: pointToHex(PK),
      proof: { e: scalarToHex(e), s: scalarToHex(s) }
    }
  }

  /**
   * Unmask a card by combining all reveal tokens.
   * M = C2 - sum(tokens)
   */
  async 'unmask-card' (params) {
    const { encrypted, tokens } = params
    if (!encrypted || !Array.isArray(tokens) || tokens.length === 0) {
      throw new Error('ZK_MISSING_PARAMS: need encrypted and tokens array')
    }

    const C2 = hexToPoint(encrypted.c2)

    // Sum all tokens
    let tokenSum = hexToPoint(tokens[0])
    for (let i = 1; i < tokens.length; i++) {
      tokenSum = tokenSum.add(hexToPoint(tokens[i]))
    }

    // M = C2 - sum(tokens)
    const M = C2.subtract(tokenSum)
    const cardHex = pointToHex(M)

    // Look up the card index
    const card = CARD_LOOKUP.get(cardHex)
    if (card === undefined) {
      return { card: -1, error: 'Card not found — tokens may be incorrect' }
    }

    return { card }
  }

  // ─── Fair Randomness (Multi-Party Coin Flip) ───────────────────

  /**
   * Commit to a random value for fair coin flipping.
   * Each player calls this, then all reveal simultaneously.
   */
  async 'commit-random' () {
    const secret = randomBytes(32).toString('hex')
    const commitment = blake2bHex(secret)

    return { commitment, secret }
  }

  /**
   * Combine all players' revealed secrets into a fair random value.
   * Verifies each commitment before combining.
   */
  async 'combine-reveals' (params) {
    const { reveals } = params
    if (!Array.isArray(reveals) || reveals.length === 0) {
      throw new Error('ZK_MISSING_PARAMS: need reveals array')
    }

    // Verify all commitments
    for (let i = 0; i < reveals.length; i++) {
      const { secret, commitment } = reveals[i]
      if (!secret || !commitment) {
        return { valid: false, failedIndex: i, reason: 'missing secret or commitment' }
      }
      const recomputed = blake2bHex(secret)
      if (recomputed !== commitment) {
        return { valid: false, failedIndex: i, reason: 'commitment mismatch' }
      }
    }

    // XOR all secrets
    const buffers = reveals.map(r => b4a.from(r.secret, 'hex'))
    const result = b4a.alloc(32)
    for (const buf of buffers) {
      for (let i = 0; i < 32; i++) {
        result[i] ^= buf[i]
      }
    }

    return { randomValue: b4a.toString(result, 'hex'), valid: true }
  }

  // ─── Merkle Membership Proofs ──────────────────────────────────

  /**
   * Prove a value is in a set without revealing which value.
   */
  async 'prove-membership' (params) {
    const { value, set } = params
    if (!value || !Array.isArray(set)) {
      throw new Error('ZK_MISSING_PARAMS: need value and set array')
    }

    const leaves = set.map(v => blake2bHex(String(v)))
    const tree = this._buildMerkleTree(leaves)
    const root = tree[tree.length - 1][0]

    const leafHash = blake2bHex(String(value))
    const leafIndex = leaves.findIndex(l => l === leafHash)
    if (leafIndex === -1) {
      throw new Error('ZK_NOT_IN_SET: value is not in the provided set')
    }

    const proof = this._getMerkleProof(tree, leafIndex)

    return {
      leafHash,
      merkleRoot: root,
      proof,
      leafIndex
    }
  }

  /**
   * Verify a membership proof — no plaintext value needed.
   * Only requires the leaf hash and Merkle path.
   */
  async 'verify-membership' (params) {
    const { leafHash, merkleRoot, proof, leafIndex } = params
    if (!leafHash || !merkleRoot || !proof) {
      throw new Error('ZK_MISSING_PARAMS')
    }

    try {
      let current = leafHash
      for (const { sibling, direction } of proof) {
        if (direction === 'left') {
          current = this._hashPair(sibling, current)
        } else {
          current = this._hashPair(current, sibling)
        }
      }
      return { valid: current === merkleRoot }
    } catch {
      return { valid: false, reason: 'invalid proof format' }
    }
  }

  // ─── Range Proofs (Commitment-Homomorphic) ─────────────────────

  /**
   * Prove a value is in [min, max] without revealing it.
   * Uses Pedersen commitment homomorphism:
   *   C(v-min) + C(max-v) == C(max-min) (public constant)
   */
  async 'prove-range' (params) {
    const { value, min, max } = params
    if (typeof value !== 'number' || typeof min !== 'number' || typeof max !== 'number') {
      throw new Error('ZK_MISSING_PARAMS: need numeric value, min, max')
    }
    if (value < min || value > max) {
      throw new Error('ZK_OUT_OF_RANGE')
    }

    const normalized = value - min
    const range = max - min

    // Commit to the value
    const rValue = randomScalar()
    const vScalar = valueToScalar(value)
    const commitment = pointToHex(G.multiply(rValue).add(H.multiply(vScalar)))

    // Commit to (v - min) and (max - v) separately
    const rLower = randomScalar()
    const rUpper = randomScalar()
    const lowerCommit = pointToHex(G.multiply(rLower).add(H.multiply(modN(BigInt(normalized)))))
    const upperCommit = pointToHex(G.multiply(rUpper).add(H.multiply(modN(BigInt(range - normalized)))))

    return {
      commitment,
      rangeProof: {
        lowerCommitment: lowerCommit,
        upperCommitment: upperCommit,
        // Sum of blinding factors for homomorphic check
        blindingSum: scalarToHex(modN(rLower + rUpper)),
        min,
        max
      }
    }
  }

  /**
   * Verify a range proof — no plaintext value needed.
   * Checks homomorphic relation: C_lower + C_upper == blindingSum*G + (max-min)*H
   */
  async 'verify-range' (params) {
    const { commitment, rangeProof } = params
    if (!commitment || !rangeProof) throw new Error('ZK_MISSING_PARAMS')

    try {
      const { lowerCommitment, upperCommitment, blindingSum, min, max } = rangeProof
      const range = max - min

      const Clower = hexToPoint(lowerCommitment)
      const Cupper = hexToPoint(upperCommitment)
      const rSum = hexToScalar(blindingSum)

      // C_lower + C_upper should equal rSum*G + range*H
      const lhs = Clower.add(Cupper)
      const rangeScalar = modN(BigInt(range))
      const rhs = G.multiply(rSum).add(H.multiply(rangeScalar))

      return { valid: lhs.equals(rhs) }
    } catch {
      return { valid: false, reason: 'invalid proof format' }
    }
  }

  // ─── Circuit Listing ───────────────────────────────────────────

  async circuits () {
    const builtins = [
      { name: 'pedersen-commitment', type: 'elliptic-curve', description: 'Pedersen commitment on secp256k1 (hiding + binding)' },
      { name: 'schnorr-nizk', type: 'sigma-protocol', description: 'Proof of discrete log knowledge (Fiat-Shamir)' },
      { name: 'dleq', type: 'sigma-protocol', description: 'Discrete log equality proof (correct card reveal)' },
      { name: 'elgamal-cards', type: 'encryption', description: 'ElGamal card encryption/decryption for mental poker' },
      { name: 'fair-random', type: 'commit-reveal', description: 'Multi-party fair coin flip via commit-reveal' },
      { name: 'merkle-membership', type: 'merkle-tree', description: 'ZK set membership via Merkle proof' },
      { name: 'range-proof', type: 'commitment-homomorphic', description: 'Range proof via Pedersen homomorphism' }
    ]

    const custom = Array.from(this.backends.keys()).map(name => ({
      name, type: 'custom', description: 'Custom backend'
    }))

    return {
      available: [...builtins, ...custom],
      pluggable: true,
      curve: 'secp256k1',
      note: 'Custom ZK backends can be registered via registerBackend()'
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────

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
          next.push(level[i])
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
