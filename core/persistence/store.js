/**
 * Persistent Store — append-only log + periodic snapshots
 *
 * Replaces crash-unsafe JSON.stringify+writeFile flushes with a durable
 * write-ahead log (WAL) strategy:
 *
 *   store-dir/
 *     current.json   - latest snapshot of the full key-value map
 *     wal.jsonl      - append-only log of changes since last snapshot
 *
 * Every `set` / `delete` appends a JSON line to `wal.jsonl` and fsyncs it
 * to disk — so a mid-flush crash only loses the very last in-flight line.
 *
 * Snapshots rewrite `current.json` atomically (tmp + rename) then truncate
 * the WAL. Snapshots trigger on a count threshold (default 1000 ops) and
 * a time threshold (default 60s). They can also be forced via `snapshot()`.
 *
 * Design choice:
 *   - Native `fs` (not `fs/promises`) for synchronous fsync durability.
 *   - Pure JSON — works in Node and bare-fs via package.json imports map.
 *   - No external deps. Chose this over Hypercore because it's simpler:
 *     no feed-key management, no corestore lifecycle, no chunking.
 */

import {
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  ftruncateSync
} from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'

const WAL_FILE = 'wal.jsonl'
const SNAPSHOT_FILE = 'current.json'
const SNAPSHOT_TMP = 'current.json.tmp'

const DEFAULT_SNAPSHOT_OPS = 1000
const DEFAULT_SNAPSHOT_MS = 60_000

export class PersistentStore extends EventEmitter {
  constructor (dir, opts = {}) {
    super()
    this.dir = dir
    this.walPath = join(dir, WAL_FILE)
    this.snapshotPath = join(dir, SNAPSHOT_FILE)
    this.snapshotTmpPath = join(dir, SNAPSHOT_TMP)

    this._map = new Map()
    this._walFd = null
    this._opsSinceSnapshot = 0
    this._closed = false

    this._snapshotOps = opts.snapshotOps || DEFAULT_SNAPSHOT_OPS
    this._snapshotMs = opts.snapshotMs || DEFAULT_SNAPSHOT_MS
    this._autoSnapshot = opts.autoSnapshot !== false

    this._snapshotTimer = null
  }

  _ensureDir () {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true })
    }
  }

  open () {
    if (this._walFd !== null) return
    this._ensureDir()

    // Load snapshot first
    if (existsSync(this.snapshotPath)) {
      try {
        const raw = readFileSync(this.snapshotPath, 'utf8')
        if (raw && raw.trim() !== '') {
          const data = JSON.parse(raw)
          for (const [k, v] of Object.entries(data)) {
            this._map.set(k, v)
          }
        }
      } catch (err) {
        this.emit('load-error', { file: this.snapshotPath, error: err })
      }
    }

    // Replay WAL on top
    if (existsSync(this.walPath)) {
      const raw = readFileSync(this.walPath, 'utf8')
      const lines = raw.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const entry = JSON.parse(trimmed)
          if (entry.op === 'set') {
            this._map.set(entry.k, entry.v)
          } else if (entry.op === 'del') {
            this._map.delete(entry.k)
          }
        } catch (err) {
          // Partial / corrupt line at end — stop replay (rest is garbage after crash)
          this.emit('wal-corrupt', { line: trimmed, error: err })
          break
        }
      }
    }

    // Open WAL for append
    this._walFd = openSync(this.walPath, 'a')

    if (this._autoSnapshot && this._snapshotMs > 0) {
      this._snapshotTimer = setInterval(() => {
        try {
          if (this._opsSinceSnapshot > 0) this.snapshot()
        } catch (err) {
          this.emit('snapshot-error', { error: err })
        }
      }, this._snapshotMs)
      if (this._snapshotTimer.unref) this._snapshotTimer.unref()
    }

    this.emit('opened', { entries: this._map.size })
  }

  _appendWal (entry) {
    if (this._walFd === null) throw new Error('STORE_NOT_OPEN')
    const line = JSON.stringify(entry) + '\n'
    writeSync(this._walFd, line)
    fsyncSync(this._walFd)
  }

  get (key) {
    return this._map.get(key)
  }

  has (key) {
    return this._map.has(key)
  }

  set (key, value) {
    if (this._closed) throw new Error('STORE_CLOSED')
    if (this._walFd === null) this.open()
    this._appendWal({ op: 'set', k: key, v: value })
    this._map.set(key, value)
    this._opsSinceSnapshot++
    if (this._autoSnapshot && this._opsSinceSnapshot >= this._snapshotOps) {
      try {
        this.snapshot()
      } catch (err) {
        this.emit('snapshot-error', { error: err })
      }
    }
  }

  delete (key) {
    if (this._closed) throw new Error('STORE_CLOSED')
    if (this._walFd === null) this.open()
    if (!this._map.has(key)) return false
    this._appendWal({ op: 'del', k: key })
    this._map.delete(key)
    this._opsSinceSnapshot++
    return true
  }

  * entries () {
    for (const entry of this._map.entries()) yield entry
  }

  keys () {
    return [...this._map.keys()]
  }

  values () {
    return [...this._map.values()]
  }

  get size () {
    return this._map.size
  }

  flush () {
    if (this._walFd === null) return
    fsyncSync(this._walFd)
  }

  /**
   * Atomically rewrite current.json from the in-memory map, then truncate WAL.
   */
  snapshot () {
    if (this._closed) return
    this._ensureDir()

    const data = {}
    for (const [k, v] of this._map) data[k] = v

    // Write tmp file, fsync, then rename (atomic on POSIX)
    const tmpFd = openSync(this.snapshotTmpPath, 'w')
    try {
      writeSync(tmpFd, JSON.stringify(data))
      fsyncSync(tmpFd)
    } finally {
      closeSync(tmpFd)
    }
    renameSync(this.snapshotTmpPath, this.snapshotPath)

    // Truncate WAL (keep fd open for further appends)
    if (this._walFd !== null) {
      try {
        ftruncateSync(this._walFd, 0)
        fsyncSync(this._walFd)
      } catch (err) {
        // Fall back: reopen
        try { closeSync(this._walFd) } catch (_) {}
        try { unlinkSync(this.walPath) } catch (_) {}
        this._walFd = openSync(this.walPath, 'a')
      }
    }

    this._opsSinceSnapshot = 0
    this.emit('snapshot', { entries: this._map.size })
  }

  close () {
    if (this._closed) return
    this._closed = true
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer)
      this._snapshotTimer = null
    }
    if (this._opsSinceSnapshot > 0) {
      try { this.snapshot() } catch (err) { this.emit('snapshot-error', { error: err }) }
    }
    if (this._walFd !== null) {
      try { fsyncSync(this._walFd) } catch (_) {}
      try { closeSync(this._walFd) } catch (_) {}
      this._walFd = null
    }
    this.emit('closed')
  }
}

/**
 * Convenience factory.
 */
export function openStore (dir, opts) {
  const store = new PersistentStore(dir, opts)
  store.open()
  return store
}
