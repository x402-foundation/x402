import { x402Client } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientCantonSigner, CantonSchemeConfig } from "../../signer.js";
import { CANTON_CAIP_FAMILY } from "../../constants.js";
import { ExactCantonScheme } from "./scheme.js";

/** Configuration for registering the Canton client scheme. */
export interface CantonClientConfig {
  /** Payer key + participant access. */
  signer: ClientCantonSigner;
  /** Trust anchors / registry config (registry trusted parties for CIP-56). */
  schemeConfig?: CantonSchemeConfig;
  /** Canton networks to register (default: the `canton:*` family). */
  networks?: Network[];
}

/**
 * Registers the Canton `exact` scheme on an x402Client instance.
 *
 * @param client - The client to register the scheme on.
 * @param config - The Canton client configuration (signer + optional config).
 * @returns The same client, for chaining.
 */
export function registerExactCantonScheme(
  client: x402Client,
  config: CantonClientConfig,
): x402Client {
  const scheme = new ExactCantonScheme(config.signer, config.schemeConfig ?? {});
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => client.register(network, scheme));
  } else {
    client.register(CANTON_CAIP_FAMILY as Network, scheme);
  }
  return client;
}
