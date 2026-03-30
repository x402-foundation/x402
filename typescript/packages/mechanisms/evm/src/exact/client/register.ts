import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientEvmSigner } from "../../signer";
import { ExactEvmScheme } from "./scheme";
import { ExactEvmSchemeOptions } from "./rpc";
import { ExactEvmSchemeV1 } from "../v1/client/scheme";
import { NETWORKS } from "../../v1";

/**
 * Configuration options for registering EVM schemes to an x402Client
 */
export interface EvmClientConfig {
  /**
   * The EVM signer to use for creating payment payloads
   */
  signer: ClientEvmSigner;

  /**
   * Optional payment requirements selector function
   * If not provided, uses the default selector (first available option)
   */
  paymentRequirementsSelector?: SelectPaymentRequirements;

  /**
   * Optional policies to apply to the client
   */
  policies?: PaymentPolicy[];

  /**
   * Optional Exact EVM client scheme options.
   * Supports either a single config ({ rpcUrl }) or per-chain configs
   * keyed by EVM chain ID ({ 8453: { rpcUrl: "..." } }).
   */
  schemeOptions?: ExactEvmSchemeOptions;

  /**
   * Optional specific networks to register.
   * If not provided, registers wildcard support (eip155:*).
   */
  networks?: Network[];
}

/**
 * Registers EVM exact payment schemes to an x402Client instance.
 *
 * This function registers:
 * - V2: eip155:* wildcard scheme with ExactEvmScheme (or specific networks if provided)
 * - V1: All supported EVM networks with ExactEvmSchemeV1
 *
 * @param client - The x402Client instance to register schemes to
 * @param config - Configuration for EVM client registration
 * @returns The client instance for chaining
 *
 * @example
 * ```typescript
 * import { registerExactEvmScheme } from "@x402/evm/exact/client/register";
 * import { x402Client } from "@x402/core/client";
 * import { privateKeyToAccount } from "viem/accounts";
 *
 * const account = privateKeyToAccount("0x...");
 * const client = new x402Client();
 * registerExactEvmScheme(client, { signer: account });
 * ```
 */
export function registerExactEvmScheme(client: x402Client, config: EvmClientConfig): x402Client {
  const evmScheme = new ExactEvmScheme(config.signer, config.schemeOptions);

  // Register V2 scheme
  // EIP-2612 gas sponsoring is handled internally by the scheme when the
  // server advertises support - no separate extension registration needed.
  if (config.networks && config.networks.length > 0) {
    // Register specific networks
    config.networks.forEach(network => {
      client.register(network, evmScheme);
    });
  } else {
    // Register wildcard for all EVM chains
    client.register("eip155:*", evmScheme);
  }

  // Register all V1 networks
  NETWORKS.forEach(network => {
    client.registerV1(network as Network, new ExactEvmSchemeV1(config.signer));
  });

  // Apply policies if provided
  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
