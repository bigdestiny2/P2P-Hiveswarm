/**
 * Services Framework — host plumbing only.
 *
 * This package (p2p-hiverelay / Core) ships only the framework for hosting
 * services: the registry, the provider base class, and the protomux protocol.
 *
 * Concrete builtin services (AI inference, identity, schemas, SLAs, storage
 * CRUD, ZK, arbitration) live in p2p-hiveservices and are loaded at runtime
 * via PluginLoader when an operator opts in.
 *
 * Usage:
 *   import { ServiceRegistry, ServiceProtocol } from 'p2p-hiverelay/core/services/index.js'
 *   import { AIService } from 'p2p-hiveservices/builtin/ai-service.js'
 *
 *   const registry = new ServiceRegistry()
 *   registry.register(new AIService())
 *
 *   const protocol = new ServiceProtocol(registry)
 *   protocol.attach(mux, remotePubkey)
 */

export { ServiceRegistry } from './registry.js'
export { ServiceProvider } from './provider.js'
export { ServiceProtocol } from './protocol.js'
