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
import { randomBytes } from '../../compat/random.js'
import dns from 'node:dns/promises'

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
    this.maxQueue = opts.maxQueue ?? 100
    this.maxJobsPerCaller = opts.maxJobsPerCaller ?? 20
    this.maxConcurrent = opts.maxConcurrent ?? 2
    this.maxInputBytes = opts.maxInputBytes ?? 256 * 1024
    this.maxOutputBytes = opts.maxOutputBytes ?? 512 * 1024
    this.allowRemoteModelRegistration = opts.allowRemoteModelRegistration === true
    this.maxCompletedJobAge = opts.maxCompletedJobAge || 3600_000
    this._running = 0
    this._queue = []
    this._cleanupTimer = null
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

  async start () {
    this._cleanupTimer = setInterval(() => this._cleanupCompletedJobs(), 60_000)
    if (this._cleanupTimer.unref) this._cleanupTimer.unref()
  }

  /**
   * Register a model endpoint.
   * @param {object} params - { modelId, type, endpoint?, handler? }
   *   endpoint: HTTP URL for remote model (e.g., http://localhost:11434/api/generate)
   *   handler: async function for local/custom inference
   */
  async 'register-model' (params, context = {}) {
    if (!this._isAdminContext(context) && !this.allowRemoteModelRegistration) {
      throw new Error('ACCESS_DENIED: model registration requires relay-admin/local context')
    }

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
      } else {
        // Check if the hostname is itself a private IP
        if (this._isPrivateIP(host)) {
          throw new Error('AI_INVALID_ENDPOINT: private/internal IPs not allowed for remote models')
        }
        // Resolve DNS and check resolved IPs for SSRF
        try {
          const { address } = await dns.lookup(host)
          if (this._isPrivateIP(address)) {
            throw new Error('AI_INVALID_ENDPOINT: hostname resolves to private/internal IP')
          }
        } catch (err) {
          if (err.message.startsWith('AI_INVALID_ENDPOINT')) throw err
          throw new Error('AI_INVALID_ENDPOINT: could not resolve hostname')
        }
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

  async 'remove-model' (params, context = {}) {
    if (!this._isAdminContext(context) && !this.allowRemoteModelRegistration) {
      throw new Error('ACCESS_DENIED: model removal requires relay-admin/local context')
    }
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
  async infer (params, context = {}) {
    const { modelId, input, options } = params
    if (!modelId || input === undefined) {
      throw new Error('AI_MISSING_PARAMS: need modelId and input')
    }

    const model = this.models.get(modelId)
    if (!model) throw new Error(`AI_MODEL_NOT_FOUND: ${modelId}`)

    this._assertSizeLimit(input, this.maxInputBytes, 'AI_INPUT_TOO_LARGE')

    if (this._countActiveJobs() >= this.maxQueue) {
      throw new Error('AI_QUEUE_FULL')
    }

    const owner = this._callerKey(context)
    if (this._countActiveJobs(owner) >= this.maxJobsPerCaller) {
      throw new Error('AI_CALLER_QUEUE_FULL')
    }

    const jobId = randomBytes(16).toString('hex')
    const job = {
      id: jobId,
      modelId,
      input,
      options: options || {},
      owner,
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
  async embed (params, context = {}) {
    const { modelId, input } = params
    if (!modelId || !input) throw new Error('AI_MISSING_PARAMS: need modelId and input')
    this._assertSizeLimit(input, this.maxInputBytes, 'AI_INPUT_TOO_LARGE')

    const model = this.models.get(modelId)
    if (!model) throw new Error(`AI_MODEL_NOT_FOUND: ${modelId}`)

    if (model.type !== 'embedding' && model.type !== 'llm') {
      throw new Error('AI_WRONG_TYPE: model does not support embeddings')
    }

    const startTime = Date.now()
    let result

    if (model.handler) {
      result = await model.handler({
        type: 'embed',
        input,
        options: params.options || {},
        context
      })
    } else if (model.endpoint) {
      result = await this._httpInfer(model, { type: 'embed', input })
    } else {
      throw new Error('AI_NO_BACKEND: model has no handler or endpoint')
    }

    this._assertSizeLimit(result, this.maxOutputBytes, 'AI_OUTPUT_TOO_LARGE')

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

      this._assertSizeLimit(result, this.maxOutputBytes, 'AI_OUTPUT_TOO_LARGE')
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
   * Supports Ollama and OpenAI-compatible APIs.
   */
  async _httpInfer (model, request) {
    const { request: httpRequest } = await import('http')
    const url = new URL(model.endpoint)
    const format = model.config.format || this._detectFormat(url)

    const payload = this._buildPayload(model, request, format)
    const path = this._resolvePath(url, request, format)

    return new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: model.config.timeout || 60_000
      }, (res) => {
        let body = ''
        res.on('data', chunk => { body += chunk })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            resolve(this._normalizeResponse(parsed, format))
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

      req.write(JSON.stringify(payload))
      req.end()
    })
  }

  _detectFormat (url) {
    if (url.port === '11434' || url.pathname.startsWith('/api/')) return 'ollama'
    if (url.pathname.includes('/v1/')) return 'openai'
    return 'generic'
  }

  _resolvePath (url, request, format) {
    // If endpoint already has a specific path, use it
    if (url.pathname !== '/' && url.pathname !== '') return url.pathname

    if (format === 'ollama') {
      if (request.type === 'embed') return '/api/embed'
      return Array.isArray(request.input) ? '/api/chat' : '/api/generate'
    }
    if (format === 'openai') {
      if (request.type === 'embed') return '/v1/embeddings'
      return Array.isArray(request.input) ? '/v1/chat/completions' : '/v1/completions'
    }
    return url.pathname || '/'
  }

  _buildPayload (model, request, format) {
    const input = request.input

    if (format === 'ollama') {
      if (request.type === 'embed') {
        return { model: model.modelId, input }
      }
      // Chat-style input: array of messages
      if (Array.isArray(input)) {
        return { model: model.modelId, messages: input, stream: false }
      }
      // Simple prompt string
      return { model: model.modelId, prompt: String(input), stream: false }
    }

    if (format === 'openai') {
      if (request.type === 'embed') {
        return { model: model.modelId, input }
      }
      if (Array.isArray(input)) {
        return { model: model.modelId, messages: input, stream: false }
      }
      return { model: model.modelId, prompt: String(input), stream: false }
    }

    // Generic: pass through as-is
    return { model: model.modelId, ...request }
  }

  _normalizeResponse (parsed, format) {
    if (format === 'ollama') {
      return {
        text: parsed.response || parsed.message?.content || null,
        tokens: parsed.eval_count || 0,
        model: parsed.model || null,
        done: parsed.done,
        raw: parsed
      }
    }
    if (format === 'openai') {
      const choice = parsed.choices?.[0]
      return {
        text: choice?.text || choice?.message?.content || null,
        tokens: parsed.usage?.total_tokens || 0,
        model: parsed.model || null,
        raw: parsed
      }
    }
    return parsed
  }

  async stop () {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer)
      this._cleanupTimer = null
    }
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

  _callerKey (context = {}) {
    if (context.remotePubkey) return context.remotePubkey
    if (context.userId) return context.userId
    if (context.caller === 'local' || context.role === 'local') return 'local'
    return 'anonymous'
  }

  _isAdminContext (context) {
    if (!context) return false
    return context.role === 'relay-admin' || context.role === 'local' || context.caller === 'local'
  }

  _isPrivateIP (ip) {
    if (!ip) return true
    if (ip === '0.0.0.0' || ip === '::') return true
    // 127.x.x.x
    if (/^127\./.test(ip)) return true
    // 10.x.x.x
    if (/^10\./.test(ip)) return true
    // 172.16-31.x.x
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true
    // 192.168.x.x
    if (/^192\.168\./.test(ip)) return true
    // 169.254.x.x (link-local)
    if (/^169\.254\./.test(ip)) return true
    // IPv6 loopback
    if (ip === '::1') return true
    // IPv6 link-local
    if (/^fe80:/i.test(ip)) return true
    // IPv6 unique local
    if (/^f[cd]/i.test(ip)) return true
    return false
  }

  _cleanupCompletedJobs () {
    const now = Date.now()
    for (const [id, job] of this.jobs) {
      if ((job.state === 'complete' || job.state === 'failed' || job.state === 'cancelled') &&
          job.completedAt && (now - job.completedAt) > this.maxCompletedJobAge) {
        this.jobs.delete(id)
      }
    }
  }

  _countActiveJobs (owner = null) {
    let total = 0
    for (const [, job] of this.jobs) {
      if (owner && job.owner !== owner) continue
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
