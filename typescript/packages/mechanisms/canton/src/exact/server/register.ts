import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { CANTON_CAIP_FAMILY } from "../../constants.js";
import { ExactCantonScheme } from "./scheme.js";

/** Configuration for registering the Canton server scheme. */
export interface CantonResourceServerConfig {
  /** Canton networks to register (default: the `canton:*` family). */
  networks?: Network[];
}

/**
 * Registers the Canton `exact` scheme on an x402ResourceServer instance.
 *
 * @param server - The resource server to register the scheme on.
 * @param config - The Canton resource-server configuration.
 * @returns The same server, for chaining.
 */
export function registerExactCantonScheme(
  server: x402ResourceServer,
  config: CantonResourceServerConfig = {},
): x402ResourceServer {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => server.register(network, new ExactCantonScheme()));
  } else {
    server.register(CANTON_CAIP_FAMILY as Network, new ExactCantonScheme());
  }
  return server;
}
