import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { SettlementCache } from "../../settlement-cache";
import { FacilitatorSvmSigner } from "../../signer";
import { AuthCaptureSvmScheme } from "./scheme";

/**
 * Configuration options for registering SVM auth-capture schemes to an x402Facilitator
 */
export interface SvmAuthCaptureFacilitatorConfig {
  /**
   * The SVM signer for facilitator operations
   */
  signer: FacilitatorSvmSigner;

  /**
   * Networks to register (single network or array of networks)
   */
  networks: Network | Network[];

  /**
   * Transaction message versions to accept and advertise
   *
   * Default: `[0, 1]`
   */
  transactionVersions?: readonly (0 | 1)[];
}

/**
 * Registers SVM auth-capture payment schemes to an existing x402Facilitator instance.
 *
 * @param facilitator - The x402Facilitator instance to register schemes to
 * @param config - Configuration for SVM auth-capture facilitator registration
 * @returns The facilitator instance for chaining
 */
export function registerAuthCaptureSvmScheme(
  facilitator: x402Facilitator,
  config: SvmAuthCaptureFacilitatorConfig,
): x402Facilitator {
  const settlementCache = new SettlementCache();

  const { transactionVersions } = config;
  facilitator.register(
    config.networks,
    new AuthCaptureSvmScheme(config.signer, settlementCache, { transactionVersions }),
  );

  return facilitator;
}
