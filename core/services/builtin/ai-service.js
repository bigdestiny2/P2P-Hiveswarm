/**
 * AI Inference Service
 *
 * Provides AI/ML inference as a decentralized service.
 * Relay nodes with GPU resources can offer inference,
 * apps consume it without managing their own models.
 *
 * Architecture:
 *   - Provider mode: Node has a model loaded, accepts inference requests
 *   - Consumer mode: Node discovers AI providers and routes requests
 *   - Marketplace: Providers compete on price/latency, earn sats
 *
 * Phase 1: HTTP-compatible inference proxy (wraps local/remote LLM APIs)
 * Phase 2: Native ONNX/GGML runtime for local inference
 *
 * Capabilities:
 *   - infer: Run inference on a model
 *   - models: List available models
 *   - register-model: Register a model endpoint
 *   - remove-model: Remove a model endpoint
 *   - embed: Generate embeddings
 *   - status: Provider status and queue depth
 */

import { ServiceProvider } from '../provider.js'
import { randomBytes } from 'crypto'

const JOB_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed'
}

export class AIService extends ServiceProvider {
  constructor (opts = {}) {
    super()
    this.models = new Map() // modelId -> ModelEntry
    this.jobs = new Map() // jobId -> InferenceJob
    this.maxQueue = opts.maxQueue || 100
    this.maxConcurrent = opts.maxConcurrent || 2
    this._running = 0
    this._queue = []
  }

  manifest () {
    return {
      name: 'ai',
      version: '1.0.0',
      description: 'AI/ML inference as a decentralized service — LLM, embeddings, classification',
      capabilities: [
        'infer', 'list-models', 'register-model',
        'remove-model', 'embed', 'status'
      ]
    }
  }

  /**
   * Register a model endpoint.
   * @param {object} params - { modelId, type, endpoint?, handler? }
   *   endpoint: HTTP URL for remote model (e.g., http://localhost:11434/api/generate)
   *   handler: async function for local/custom inference
   */
  async 'register-model' (params) {
    const { modelId, type, endpoint, config } = params
    if (!modelId || !type) throw new Error('AI_MISSING_PARAMS: need modelId and type')

    if (this.models.has(modelId)) throw new Error(`AI_MODEL_EXISTS: ${modelId}`)

    // Validate endpoint URL if provided
    if (endpoint) {
      let parsed
      try { parsed = new URL(endpoint) } catch { throw new Error('AI_INVALID_ENDPOINT: malformed URL') }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('AI_INVALID_ENDPOINT: only http/https allowed')
      }
      const host = parsed.hostname
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        // Allow localhost for local models (Ollama, etc.)
      } else if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.)/.test(host) || host === '169.254') {
        throw new Error('AI_INVALID_ENDPOINT: private/internal IPs not allowed for remote models')
      }
    }

    const entry = {
      modelId,
      type, // 'llm', 'embedding', 'classification', 'image', 'custom'
      endpoint: endpoint || null,
      config: config || {},
      handler: null, // Set programmatically, not via RPC
      registeredAt: Date.now(),
      stats: { requests: 0, errors: 0, totalTokens: 0, totalLatencyMs: 0 }
    }

    this.models.set(modelId, entry)
    return { modelId, type, registered: true }
  }

  /**
   * Register a handler function directly (programmatic, not via RPC).
   */
  registerHandler (modelId, handler) {
    const entry = this.models.get(modelId)
    if (!entry) throw new Error(`AI_MODEL_NOT_FOUND: ${modelId}`)
    entry.handler = handler
  }

  async 'remove-model' (params) {
    const removed = this.models.delete(params.modelId)
    return { modelId: params.modelId, removed }
  }

  async 'list-models' () {
    const list = []
    for (const [id, entry] of this.models) {
      list.push({
        modelId: id,
        type: entry.type,
        hasEndpoint: !!entry.endpoint,
        hasHandler: !!entry.handler,
        stats: entry.stats
      })
    }
    return list
  }

  /**
   * Run inference on a model.
   */
  async infer (params) {
    const { modelId, input, options } = params
    if (!modelId || input === undefined) {
      throw new Error('AI_MISSING_PARAMS: need modelId and input')
    }

    const model = this.models.get(modelId)
    if (!model) throw new Error(`AI_MODEL_NOT_FOUND: ${modelId}`)

    if (this.jobs.size >= this.maxQueue) {
      throw new Error('AI_QUEUE_FULL')
    }

    const jobId = randomBytes(16).toString('hex')
    const job = {
      id: jobId,
      modelId,
      input,
      options: options || {},
      state: JOB_STATES.PENDING,
      result: null,
      error: null,
      createdAt: Date.now(),
      completedAt: null
    }

    this.jobs.set(jobId, job)

    // If we can run immediately, do it
    if (this._running < this.maxConcurrent) {
      await this._runJob(job, model)
    } else {
      this._queue.push(jobId)
    }

    return {
      jobId,
      state: job.state,
      result: job.state === JOB_STATES.COMPLETE ? job.result : undefined,
      error: job.state === JOB_STATES.FAILED ? job.error : undefined
    }
  }

  /**
   * Generate embeddings.
   */
  async embed (params) {
    const { modelId, input } = params
    if (!modelId || !input) throw new Error('AI_MISSING_PARAMS: need modelId and input')

    const model = this.models.get(modelId)
    if (!model) throw new Error(`AI_MODEL_NOT_FOUND: ${modelId}`)

    if (model.type !== 'embedding' && model.type !== 'llm') {
      throw new Error('AI_WRONG_TYPE: model does not support embeddings')
    }

    const startTime = Date.now()
    let result

    if (model.handler) {
      result = await model.handler({ type: 'embed', input, options: params.options || {} })
    } else if (model.endpoint) {
      result = await this._httpInfer(model, { type: 'embed', input })
    } else {
      throw new Error('AI_NO_BACKEND: model has no handler or endpoint')
    }

    model.stats.requests++
    model.stats.totalLatencyMs += Date.now() - startTime

    return result
  }

  async status () {
    const modelStats = {}
    for (const [id, model] of this.models) {
      modelStats[id] = {
        type: model.type,
        avgLatencyMs: model.stats.requests > 0
          ? Math.round(model.stats.totalLatencyMs / model.stats.requests)
          : 0,
        ...model.stats
      }
    }

    return {
      models: this.models.size,
      queueDepth: this._queue.length,
      running: this._running,
      maxConcurrent: this.maxConcurrent,
      totalJobs: this.jobs.size,
      modelStats
    }
  }

  async _runJob (job, model) {
    this._running++
    job.state = JOB_STATES.RUNNING
    const startTime = Date.now()

    try {
      let result
      if (model.handler) {
        result = await model.handler({ type: 'infer', input: job.input, options: job.options })
      } else if (model.endpoint) {
        result = await this._httpInfer(model, { type: 'infer', input: job.input })
      } else {
        throw new Error('AI_NO_BACKEND: model has no handler or endpoint')
      }

      job.state = JOB_STATES.COMPLETE
      job.result = result
      job.completedAt = Date.now()

      model.stats.requests++
      model.stats.totalLatencyMs += Date.now() - startTime
      if (result && result.tokens) model.stats.totalTokens += result.tokens
    } catch (err) {
      job.state = JOB_STATES.FAILED
      job.error = err.message
      job.completedAt = Date.now()
      model.stats.errors++
    } finally {
      this._running--
      this._processQueue()
    }
  }

  _processQueue () {
    while (this._running < this.maxConcurrent && this._queue.length > 0) {
      const jobId = this._queue.shift()
      const job = this.jobs.get(jobId)
      if (!job || job.state !== JOB_STATES.PENDING) continue
      const model = this.models.get(job.modelId)
      if (!model) continue
      this._runJob(job, model)
    }
  }

  /**
   * HTTP inference for endpoint-based models.
   * Supports Ollama, OpenAI-compatible, and generic HTTP APIs.
   */
  async _httpInfer (model, request) {
    // Dynamic import to avoid hard dependency
    const { request: httpRequest } = await import('http')
    const url = new URL(model.endpoint)

    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: model.config.timeout || 60_000
      }, (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve({ raw: body })
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('AI_TIMEOUT'))
      })

      req.write(JSON.stringify({
        model: model.modelId,
        ...request
      }))
      req.end()
    })
  }

  async stop () {
    for (const [, job] of this.jobs) {
      if (job.state === JOB_STATES.PENDING) {
        job.state = JOB_STATES.FAILED
        job.error = 'SERVICE_STOPPED'
        job.completedAt = Date.now()
      }
    }
    this._queue = []
    this.jobs.clear()
  }
}
