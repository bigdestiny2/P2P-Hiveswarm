/**
 * JS Sandbox Worker
 *
 * Runs arbitrary JavaScript in an isolated worker thread.
 * Receives code and input data via workerData, executes in a vm context,
 * and posts back the result or error.
 *
 * This replaces the unsafe vm.runInContext in the main thread,
 * providing crash and timeout isolation via worker_threads.
 */

import { parentPort, workerData } from 'worker_threads'
import vm from 'node:vm'

const { code, input, timeout } = workerData || {}

// Create a minimal vm context with only the provided input and a no-op console
const ctx = vm.createContext({
  input: input || {},
  console: {
    log: () => {},
    error: () => {},
    warn: () => {},
    info: () => {}
  }
})

try {
  const result = vm.runInContext(code, ctx, {
    timeout: timeout || 5000,
    displayErrors: true
  })
  parentPort.postMessage({ result })
} catch (err) {
  parentPort.postMessage({ error: err.message })
}
