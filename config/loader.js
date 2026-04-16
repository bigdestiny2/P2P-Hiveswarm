/**
 * Configuration Loader
 *
 * Priority (highest first):
 *   1. CLI flags (passed as overrides)
 *   2. ~/.hiverelay/config.json (user config file)
 *   3. config/default.js (built-in defaults)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import defaults from './default.js'

const HIVERELAY_DIR = join(homedir(), '.hiverelay')
const CONFIG_PATH = join(HIVERELAY_DIR, 'config.json')
const STORAGE_DIR = join(HIVERELAY_DIR, 'storage')

export { HIVERELAY_DIR, CONFIG_PATH, STORAGE_DIR }

/**
 * Load config: defaults < config.json < CLI overrides
 */
export function loadConfig (cliOverrides = {}) {
  let fileConfig = {}

  if (existsSync(CONFIG_PATH)) {
    try {
      fileConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    } catch {
      // Ignore malformed config file
    }
  }

  // Deep merge: defaults < file < CLI (preserves nested object keys)
  const config = deepMerge(deepMerge(defaults, fileConfig), cliOverrides)

  // Always resolve storage to absolute path
  if (config.storage === defaults.storage && fileConfig.storage == null && cliOverrides.storage == null) {
    config.storage = STORAGE_DIR
  }

  return config
}

/**
 * Write config to ~/.hiverelay/config.json
 */
export function saveConfig (config) {
  mkdirSync(HIVERELAY_DIR, { recursive: true })
  mkdirSync(STORAGE_DIR, { recursive: true })

  // Only persist non-default values
  const toSave = {}
  for (const [key, val] of Object.entries(config)) {
    if (JSON.stringify(val) !== JSON.stringify(defaults[key])) {
      toSave[key] = val
    }
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(toSave, null, 2) + '\n')
  return CONFIG_PATH
}

/**
 * Ensure ~/.hiverelay directory structure exists
 */
export function ensureDirs () {
  mkdirSync(HIVERELAY_DIR, { recursive: true })
  mkdirSync(STORAGE_DIR, { recursive: true })
}

/**
 * Recursively merge source into target, preserving sibling keys in nested objects.
 */
function deepMerge (target, source) {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key])
    } else {
      result[key] = source[key]
    }
  }
  return result
}
