/**
 * Services Layer
 *
 * Two-layer architecture:
 *   Apps Layer  — User-facing applications (Ghost Drive, chat, social)
 *   Services Layer — Headless capabilities apps consume via RPC
 *
 * HiveRelay nodes host services and bridge them to apps.
 * Services are: storage, identity, compute, payment, relay,
 * and any custom services (zk-proofs, AI inference, etc.)
 *
 * Usage:
 *   import { ServiceRegistry, ServiceProtocol } from './core/services/index.js'
 *   import { StorageService } from './core/services/builtin/storage-service.js'
 *
 *   const registry = new ServiceRegistry()
 *   registry.register(new StorageService())
 *
 *   const protocol = new ServiceProtocol(registry)
 *   // Attach to Protomux on each connection
 *   protocol.attach(mux, remotePubkey)
 */

export { ServiceRegistry } from './registry.js'
export { ServiceProvider } from './provider.js'
export { ServiceProtocol } from './protocol.js'
export { StorageService } from './builtin/storage-service.js'
export { IdentityService } from './builtin/identity-service.js'
export { ComputeService } from './builtin/compute-service.js'
export { ZKService } from './builtin/zk-service.js'
export { AIService } from './builtin/ai-service.js'
export { SLAService } from './builtin/sla-service.js'
export { SchemaService } from './builtin/schema-service.js'
export { ArbitrationService } from './builtin/arbitration-service.js'
