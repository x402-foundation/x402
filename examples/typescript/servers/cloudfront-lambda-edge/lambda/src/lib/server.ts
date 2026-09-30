import type { RoutesConfig, FacilitatorConfig } from '@x402/core/server';
import { x402ResourceServer, x402HTTPResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';

/**
 * Configuration for creating an x402 server
 */
export interface X402ServerConfig {
  /** Facilitator URL (e.g., 'https://x402.org/facilitator') */
  facilitatorUrl: string;
  /** Route configuration defining which paths require payment */
  routes: RoutesConfig;
  /** Optional facilitator config with auth headers (for facilitators that require authentication) */
  facilitatorConfig?: FacilitatorConfig;
}

/**
 * Creates and initializes an x402HTTPResourceServer.
 * 
 * @example
 * ```typescript
 * // Testnet (no auth)
 * const server = await createX402Server({
 *   facilitatorUrl: 'https://x402.org/facilitator',
 *   routes: { ... }, // Networks offered per route come from the routes' accepts entries
 * });
 * 
 * // Mainnet with auth (pass a facilitator config from your facilitator package)
 * const server = await createX402Server({
 *   facilitatorUrl: 'https://your-facilitator-url',
 *   routes: { ... },
 *   facilitatorConfig: createFacilitatorConfig('api-key-id', 'api-key-secret'),
 * });
 * ```
 */
export async function createX402Server(config: X402ServerConfig): Promise<x402HTTPResourceServer> {
  const facilitator = new HTTPFacilitatorClient(
    config.facilitatorConfig ?? { url: config.facilitatorUrl },
  );
  const resourceServer = new x402ResourceServer(facilitator)
    .register('eip155:*', new ExactEvmScheme())
    .register('solana:*', new ExactSvmScheme());

  const httpServer = new x402HTTPResourceServer(resourceServer, config.routes);
  await httpServer.initialize();

  return httpServer;
}
