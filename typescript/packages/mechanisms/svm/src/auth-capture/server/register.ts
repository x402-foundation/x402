import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { AuthCaptureSvmScheme } from "./scheme";

/**
 * Configuration options for registering SVM auth-capture schemes to an x402ResourceServer
 */
export interface SvmAuthCaptureResourceServerConfig {
  /**
   * Optional specific networks to register
   */
  networks?: Network[];
  /**
   * Optional RPC endpoint. When set, the scheme embeds a recent blockhash in
   * the 402 challenge (`extra.recentBlockhash`) so clients can skip their own
   * `getLatestBlockhash` round-trip.
   */
  rpcUrl?: string;
}

/**
 * Registers SVM auth-capture payment schemes to an existing x402ResourceServer instance.
 *
 * @param server - The x402ResourceServer instance to register schemes to
 * @param config - Configuration for SVM auth-capture resource server registration
 * @returns The server instance for chaining
 */
export function registerAuthCaptureSvmScheme(
  server: x402ResourceServer,
  config: SvmAuthCaptureResourceServerConfig = {},
): x402ResourceServer {
  const options = { rpcUrl: config.rpcUrl };
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      server.register(network, new AuthCaptureSvmScheme(options));
    });
  } else {
    server.register("solana:*", new AuthCaptureSvmScheme(options));
  }

  return server;
}
