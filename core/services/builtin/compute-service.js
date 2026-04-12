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
    this.maxJobs = opts.maxJobs || 1000
    this.maxConcurrent = opts.maxConcurrent || 4
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

  async submit (params) {
    if (this.jobs.size >= this.maxJobs) {
      throw new Error('JOB_LIMIT: max jobs reached')
    }

    const { type, input, priority } = params
    if (!this.handlers.has(type)) {
      throw new Error(`UNKNOWN_TASK_TYPE: ${type}`)
    }

    const jobId = randomBytes(16).toString('hex')
    const job = {
      id: jobId,
      type,
      input,
      priority: priority || 0,
      state: JOB_STATES.PENDING,
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null
    }

    this.jobs.set(jobId, job)
    this._queue.push(jobId)
    this._processQueue()

    return { jobId, state: job.state }
  }

  async status (params) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    return {
      jobId: job.id,
      state: job.state,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt
    }
  }

  async result (params) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
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

  async cancel (params) {
    const job = this.jobs.get(params.jobId)
    if (!job) throw new Error('JOB_NOT_FOUND')
    if (job.state === JOB_STATES.COMPLETE || job.state === JOB_STATES.FAILED) {
      return { jobId: job.id, cancelled: false, reason: 'already finished' }
    }

    job.state = JOB_STATES.CANCELLED
    job.completedAt = Date.now()
    this._queue = this._queue.filter(id => id !== job.id)

    return { jobId: job.id, cancelled: true }
  }

  async list () {
    const jobs = []
    for (const [, job] of this.jobs) {
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
        .then(() => handler(job.input))
        .then(result => {
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
}
