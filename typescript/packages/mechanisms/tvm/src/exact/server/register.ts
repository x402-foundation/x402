import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { ExactTvmScheme } from "./scheme";
import { TVM_MAINNET, TVM_TESTNET } from "../../constants";

/**
 * Configuration options for registering TVM schemes to an x402ResourceServer
 */
export interface TvmResourceServerConfig {
  /**
   * Optional specific networks to register.
   * If not provided, registers both mainnet and testnet.
   */
  networks?: Network[];
}

/**
 * Registers TVM exact payment schemes to an x402ResourceServer instance.
 *
 * @param server - The x402ResourceServer instance to register schemes to
 * @param config - Configuration for TVM resource server registration
 * @returns The server instance for chaining
 */
export function registerExactTvmScheme(
  server: x402ResourceServer,
  config: TvmResourceServerConfig = {},
): x402ResourceServer {
  const tvmScheme = new ExactTvmScheme();

  if (config.networks && config.networks.length > 0) {
    config.networks.forEach((network) => {
      server.register(network, tvmScheme);
    });
  } else {
    server.register(TVM_MAINNET as Network, tvmScheme);
    server.register(TVM_TESTNET as Network, tvmScheme);
  }

  return server;
}
