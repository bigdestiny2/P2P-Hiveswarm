/**
 * Worker Thread Entry Point
 *
 * Generic task dispatcher for CPU-heavy operations.
 * Receives { id, taskType, payload } messages from the pool manager.
 * Sends back { id, result } or { id, error }.
 */

import { parentPort } from 'worker_threads'

const handlers = new Map()

// --- Built-in heavy task handlers ---

handlers.set('echo', async (payload) => {
  // Test/debug handler
  return payload
})

// --- Message handler ---

parentPort.on('message', async (msg) => {
  // Dynamic handler registration
  if (msg.type === 'register') {
    try {
      const mod = await import(msg.modulePath)
      handlers.set(msg.taskType, mod.default || mod.handler)
      parentPort.postMessage({ type: 'registered', taskType: msg.taskType })
    } catch (err) {
      parentPort.postMessage({ type: 'register-error', taskType: msg.taskType, error: err.message })
    }
    return
  }

  // Task dispatch
  const { id, taskType, payload } = msg
  const handler = handlers.get(taskType)

  if (!handler) {
    parentPort.postMessage({ id, error: `UNKNOWN_TASK: ${taskType}` })
    return
  }

  try {
    const result = await handler(payload)
    parentPort.postMessage({ id, result })
  } catch (err) {
    parentPort.postMessage({ id, error: err.message })
  }
})
