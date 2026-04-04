/**
 * Structured logger for HiveRelay
 *
 * Wraps pino for JSON-structured, leveled logging.
 * In production: JSON to stdout (pipe to file or journald).
 * In development: human-readable via pino-pretty.
 *
 * Usage:
 *   import { createLogger } from '../core/logger.js'
 *   const log = createLogger({ name: 'relay-node' })
 *   log.info({ port: 9100 }, 'API started')
 *   log.error({ err }, 'connection failed')
 */

import pino from 'pino'

const DEFAULT_LEVEL = process.env.HIVERELAY_LOG_LEVEL || 'info'

export function createLogger (opts = {}) {
  const name = opts.name || 'hiverelay'
  const level = opts.level || DEFAULT_LEVEL

  return pino({
    name,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level (label) {
        return { level: label }
      }
    },
    serializers: {
      err: pino.stdSerializers.err
    }
  })
}
