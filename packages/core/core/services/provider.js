/**
 * ServiceProvider — Base class for all services
 *
 * A service is a headless capability that apps consume via RPC.
 * Each service declares a manifest (name, version, capabilities)
 * and exposes methods that match its capabilities.
 *
 * Built-in services: storage, identity, relay, payment
 * Plugin services: zk-proofs, ai-inference, custom
 *
 * Example:
 *   class MyService extends ServiceProvider {
 *     manifest () {
 *       return { name: 'my-service', version: '1.0.0', capabilities: ['echo'] }
 *     }
 *     async echo (params) { return params }
 *   }
 */

export class ServiceProvider {
  /**
   * Return service manifest.
   * @returns {{ name: string, version: string, capabilities: string[], description?: string }}
   */
  manifest () {
    throw new Error('ServiceProvider.manifest() must be implemented')
  }

  /**
   * Called when the service is started (optional).
   * @param {object} context - { node, store, config }
   */
  async start (context) {}

  /**
   * Called when the service is stopped (optional).
   */
  async stop () {}
}
