import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { FacilitatorEvmSigner } from "../../signer";
import { ExactEvmScheme } from "./scheme";
import { ExactEvmSchemeV1 } from "../v1/facilitator/scheme";
import { NETWORKS } from "../../v1";

/**
 * Configuration options for registering EVM schemes to an x402Facilitator
 */
export interface EvmFacilitatorConfig {
  /**
   * The EVM signer for facilitator operations (verify and settle)
   */
  signer: FacilitatorEvmSigner;

  /**
   * Networks to register (single network or array of networks)
   * Examples: "eip155:84532", ["eip155:84532", "eip155:1"]
   */
  networks: Network | Network[];

  /**
   * If enabled, the facilitator will deploy ERC-4337 smart wallets
   * via EIP-6492 when encountering undeployed contract signatures.
   *
   * @default false
   */
  deployERC4337WithEIP6492?: boolean;

  /**
   * If enabled, reruns on-chain simulation during settle's re-verify.
   *
   * @default false
   */
  simulateInSettle?: boolean;
}

/**
 * Registers EVM exact payment schemes to an x402Facilitator instance.
 *
 * This function registers:
 * - V2: Specified networks with ExactEvmScheme
 * - V1: All supported EVM networks with ExactEvmSchemeV1
 *
 * @param facilitator - The x402Facilitator instance to register schemes to
 * @param config - Configuration for EVM facilitator registration
 * @returns The facilitator instance for chaining
 *
 * @example
 * ```typescript
 * import { registerExactEvmScheme } from "@x402/evm/exact/facilitator/register";
 * import { x402Facilitator } from "@x402/core/facilitator";
 * import { createPublicClient, createWalletClient } from "viem";
 *
 * const facilitator = new x402Facilitator();
 *
 * // Single network
 * registerExactEvmScheme(facilitator, {
 *   signer: combinedClient,
 *   networks: "eip155:84532"  // Base Sepolia
 * });
 *
 * // Multiple networks (will auto-derive eip155:* pattern)
 * registerExactEvmScheme(facilitator, {
 *   signer: combinedClient,
 *   networks: ["eip155:84532", "eip155:1"]  // Base Sepolia and Mainnet
 * });
 * ```
 */
export function registerExactEvmScheme(
  facilitator: x402Facilitator,
  config: EvmFacilitatorConfig,
): x402Facilitator {
  // Register V2 scheme with specified networks
  facilitator.register(
    config.networks,
    new ExactEvmScheme(config.signer, {
      deployERC4337WithEIP6492: config.deployERC4337WithEIP6492,
      simulateInSettle: config.simulateInSettle,
    }),
  );

  // Register all V1 networks
  facilitator.registerV1(
    NETWORKS as Network[],
    new ExactEvmSchemeV1(config.signer, {
      deployERC4337WithEIP6492: config.deployERC4337WithEIP6492,
      simulateInSettle: config.simulateInSettle,
    }),
  );

  return facilitator;
}
