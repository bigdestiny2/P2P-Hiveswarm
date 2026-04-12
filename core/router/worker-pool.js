/**
 * Worker Thread Pool
 *
 * Manages a pool of Node.js worker_threads for CPU-heavy tasks.
 * Main thread stays responsive for I/O-bound relay operations.
 *
 * Pool size 0 means disabled — everything runs in-process.
 */

import { Worker } from 'worker_threads'
import { EventEmitter } from 'events'

export class WorkerPool extends EventEmitter {
  constructor (opts = {}) {
    super()
    this._size = opts.size ?? 0
    this._workerScript = opts.workerScript
    this._maxQueueSize = opts.maxQueueSize ?? 1000
    this._taskTimeout = opts.taskTimeout ?? 60_000
    this._workers = [] // [{ worker, busy, currentTask }]
    this._queue = [] // [{ id, taskType, payload, resolve, reject, timer, opts }]
    this._nextTaskId = 1
    this.started = false
  }

  async start () {
    if (this.started || this._size === 0) return

    for (let i = 0; i < this._size; i++) {
      this._spawnWorker(i)
    }

    this.started = true
    this.emit('started', { size: this._size })
  }

  _spawnWorker (index) {
    const scriptPath = this._workerScript instanceof URL
      ? new URL(this._workerScript).pathname
      : this._workerScript

    const worker = new Worker(scriptPath)
    const state = {
      worker,
      index,
      busy: false,
      currentTask: null
    }

    worker.on('message', (msg) => this._onWorkerMessage(state, msg))
    worker.on('error', (err) => this._onWorkerError(state, err))
    worker.on('exit', (code) => this._onWorkerExit(state, code))

    this._workers[index] = state
    return state
  }

  /**
   * Run a task in the worker pool.
   *
   * @param {string} taskType - Task type identifier
   * @param {*} payload - Task payload (must be structured-cloneable)
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Override default timeout
   * @returns {Promise<*>} Task result
   */
  run (taskType, payload, opts = {}) {
    if (!this.started) {
      return Promise.reject(new Error('WORKER_POOL_NOT_STARTED'))
    }

    const timeout = opts.timeout || this._taskTimeout

    return new Promise((resolve, reject) => {
      const task = {
        id: this._nextTaskId++,
        taskType,
        payload,
        resolve,
        reject,
        timer: null
      }

      task.timer = setTimeout(() => {
        task.reject(new Error('WORKER_TASK_TIMEOUT'))
        // Remove from queue if still there
        const qIdx = this._queue.indexOf(task)
        if (qIdx !== -1) this._queue.splice(qIdx, 1)
      }, timeout)

      // Try to dispatch immediately to a free worker
      const free = this._workers.find(w => w && !w.busy)
      if (free) {
        this._dispatch(free, task)
      } else {
        if (this._queue.length >= this._maxQueueSize) {
          clearTimeout(task.timer)
          reject(new Error('WORKER_QUEUE_FULL'))
          return
        }
        this._queue.push(task)
      }
    })
  }

  _dispatch (workerState, task) {
    workerState.busy = true
    workerState.currentTask = task

    workerState.worker.postMessage({
      id: task.id,
      taskType: task.taskType,
      payload: task.payload
    })
  }

  _onWorkerMessage (workerState, msg) {
    const task = workerState.currentTask
    if (!task || task.id !== msg.id) return

    clearTimeout(task.timer)
    workerState.busy = false
    workerState.currentTask = null

    if (msg.error) {
      task.reject(new Error(msg.error))
    } else {
      task.resolve(msg.result)
    }

    // Dequeue next task
    if (this._queue.length > 0) {
      const next = this._queue.shift()
      this._dispatch(workerState, next)
    }
  }

  _onWorkerError (workerState, err) {
    const task = workerState.currentTask
    if (task) {
      clearTimeout(task.timer)
      task.reject(new Error(`WORKER_CRASH: ${err.message}`))
      workerState.currentTask = null
    }
    workerState.busy = false

    this.emit('worker-error', { index: workerState.index, error: err.message })

    // Respawn after brief delay
    setTimeout(() => {
      if (this.started) {
        this._spawnWorker(workerState.index)
        // Drain queue to new worker
        if (this._queue.length > 0) {
          const next = this._queue.shift()
          this._dispatch(this._workers[workerState.index], next)
        }
      }
    }, 100)
  }

  _onWorkerExit (workerState, code) {
    if (code !== 0 && this.started) {
      this.emit('worker-exit', { index: workerState.index, code })
      // Will be respawned by _onWorkerError if error event fires first,
      // otherwise respawn here
      if (!workerState.busy) {
        setTimeout(() => {
          if (this.started) this._spawnWorker(workerState.index)
        }, 100)
      }
    }
  }

  getStats () {
    return {
      size: this._size,
      busy: this._workers.filter(w => w && w.busy).length,
      queueLength: this._queue.length,
      started: this.started
    }
  }

  async stop () {
    if (!this.started) return

    this.started = false

    // Reject queued tasks
    for (const task of this._queue) {
      clearTimeout(task.timer)
      task.reject(new Error('WORKER_POOL_STOPPING'))
    }
    this._queue = []

    // Terminate workers
    const terminatePromises = this._workers.map(async (state) => {
      if (!state) return
      if (state.currentTask) {
        clearTimeout(state.currentTask.timer)
        state.currentTask.reject(new Error('WORKER_POOL_STOPPING'))
      }
      await state.worker.terminate()
    })

    await Promise.allSettled(terminatePromises)
    this._workers = []
    this.emit('stopped')
  }
}
