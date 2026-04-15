/**
 * Compute Service
 *
 * Provides sandboxed compute capabilities for apps.
 * This is the "compute as a service" layer — apps submit
 * jobs and relay nodes execute them, earning sats.
 *
 * Phase 1: Simple task queue with function execution
 * Future: WASM sandboxing, GPU inference, ZK proof generation
 *
 * Capabilities:
 *   - submit: Submit a compute job
 *   - status: Check job status
 *   - result: Get job result
 *   - cancel: Cancel a pending job
 *   - list: List all jobs
 *   - capabilities: What compute types are available
 */

import { ServiceProvider } from '../provider.js'
import { randomBytes } from 'crypto'

const JOB_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
}

export class ComputeService extends ServiceProvider {
  constructor (opts = {}) {
    super()
    this.jobs = new Map() // jobId -> Job
    this.maxJobs = opts.maxJobs ?? 1000
    this.maxJobsPerCaller = opts.maxJobsPerCaller ?? 100
    this.maxConcurrent = opts.maxConcurrent ?? 4
    this.maxInputBytes = opts.maxInputBytes ?? 256 * 1024
    this.maxResultBytes = opts.maxResultBytes ?? 512 * 1024
    this.maxExecutionMs = opts.maxExecutionMs ?? 30_000
    this.handlers = new Map() // taskType -> handler function
    this._running = 0
    this._queue = [] // pending job IDs
  }

  manifest () {
    return {
      name: 'compute',
      version: '1.0.0',
      description: 'Sandboxed compute execution for apps — task queue, future WASM/ZK/AI',
      capabilities: ['submit', 'status', 'result', 'cancel', 'list', 'capabilities']
    }
  }

  /**
   * Register a compute handler for a task type.
   * Handlers are sync or async functions: (params) => result
   */
  registerHandler (taskType, handler) {
    this.handlers.set(taskType, handler)
  }

  async submit (params, context = {}) {
    if (this.jobs.size >= this.maxJobs) {
      throw new Error('JOB_LIMIT: max jobs reached')
    }

    const { type, input, priority } = params
    if (!this.handlers.has(type)) {
      throw new Error(`UNKNOWN_TASK_TYPE: ${type}`)
    }

    const owner = this._callerKey(context)
    if (this._countActiveJobs(owner) >= this.maxJobsPerCaller) {
      throw new Error('CALLER_JOB_LIMIT: too many active jobs for this caller')
    }

    this._assertSizeLimit(input, this.maxInputBytes, 'JOB_INPUT_TOO_LARGE')

    const jobId = randomBytes(16).toString('hex')
    const job = {
      id: jobId,
      type,
      input,
      priority: priority || 0,
      state: JOB_STATES.PENDING,
      result: null,
      error: null,
      owner,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null
    }

    this.jobs.set(jobId, job)
    this._queue.push(jobId)
    this._processQueue()

    return { jobId, state: job.state }
  }

  async status (params, context = {}) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    this._assertCanAccess(job, context)
    return {
      jobId: job.id,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    }
  }

  async result (params, context = {}) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    this._assertCanAccess(job, context)
    if (job.state === JOB_STATES.PENDING || job.state === JOB_STATES.RUNNING) {
      return { jobId: job.id, state: job.state, ready: false }
    }
    return {
      jobId: job.id,
      state: job.state,
      ready: true,
      result: job.result,
      error: job.error
    }
  }

  async cancel (params, context = {}) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    this._assertCanAccess(job, context)
    if (job.state === JOB_STATES.COMPLETE || job.state === JOB_STATES.FAILED) {
      return { jobId: job.id, cancelled: false, reason: 'already finished' }
    }

    job.state = JOB_STATES.CANCELLED
    job.completedAt = Date.now()
    this._queue = this._queue.filter(id => id !== job.id)

    return { jobId: job.id, cancelled: true }
  }

  async list (_params = {}, context = {}) {
    const jobs = []
    const caller = this._callerKey(context)
    const canSeeAll = this._isAdminContext(context)
    for (const [, job] of this.jobs) {
      if (!canSeeAll && job.owner !== caller) continue
      jobs.push({
        jobId: job.id,
        type: job.type,
        state: job.state,
        createdAt: job.createdAt
      })
    }
    return jobs
  }

  async capabilities () {
    return {
      taskTypes: [...this.handlers.keys()],
      maxConcurrent: this.maxConcurrent,
      maxJobs: this.maxJobs,
      maxJobsPerCaller: this.maxJobsPerCaller,
      maxInputBytes: this.maxInputBytes,
      maxResultBytes: this.maxResultBytes,
      maxExecutionMs: this.maxExecutionMs,
      currentJobs: this.jobs.size,
      runningJobs: this._running
    }
  }

  _processQueue () {
    while (this._running < this.maxConcurrent && this._queue.length > 0) {
      const jobId = this._queue.shift()
      const job = this.jobs.get(jobId)
      if (!job || job.state !== JOB_STATES.PENDING) continue

      this._running++
      job.state = JOB_STATES.RUNNING
      job.startedAt = Date.now()

      const handler = this.handlers.get(job.type)
      Promise.resolve()
        .then(() => Promise.race([
          Promise.resolve().then(() => handler(job.input)),
          new Promise((_resolve, reject) => setTimeout(() => reject(new Error('JOB_TIMEOUT')), this.maxExecutionMs))
        ]))
        .then(result => {
          this._assertSizeLimit(result, this.maxResultBytes, 'JOB_RESULT_TOO_LARGE')
          job.state = JOB_STATES.COMPLETE
          job.result = result
          job.completedAt = Date.now()
        })
        .catch(err => {
          job.state = JOB_STATES.FAILED
          job.error = err.message
          job.completedAt = Date.now()
        })
        .finally(() => {
          this._running--
          this._processQueue()
        })
    }
  }

  async stop () {
    // Cancel all pending jobs
    for (const jobId of this._queue) {
      const job = this.jobs.get(jobId)
      if (job) {
        job.state = JOB_STATES.CANCELLED
        job.completedAt = Date.now()
      }
    }
    this._queue = []
    this.jobs.clear()
  }

  _callerKey (context = {}) {
    if (context.remotePubkey) return context.remotePubkey
    if (context.userId) return context.userId
    if (context.caller === 'local' || context.role === 'local') return 'local'
    return 'anonymous'
  }

  _isAdminContext (context = {}) {
    return context.role === 'relay-admin' || context.role === 'local' || context.caller === 'local'
  }

  _assertCanAccess (job, context = {}) {
    if (this._isAdminContext(context)) return
    if (job.owner === this._callerKey(context)) return
    throw new Error('ACCESS_DENIED: job owned by another caller')
  }

  _countActiveJobs (owner) {
    let total = 0
    for (const [, job] of this.jobs) {
      if (job.owner !== owner) continue
      if (job.state === JOB_STATES.PENDING || job.state === JOB_STATES.RUNNING) total++
    }
    return total
  }

  _assertSizeLimit (value, limit, code) {
    if (!limit || limit <= 0) return
    let size = 0
    try {
      size = Buffer.byteLength(JSON.stringify(value || null))
    } catch {
      throw new Error(`${code}: payload is not serializable`)
    }
    if (size > limit) {
      throw new Error(`${code}: payload exceeds ${limit} bytes`)
    }
  }
}
