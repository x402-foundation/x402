import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { ExactTvmScheme, ExactTvmSchemeConfig } from "./scheme";

/**
 * Configuration options for registering TVM schemes to an x402Facilitator
 */
export interface TvmFacilitatorConfig {
  /**
   * Networks to register (single network or array of networks)
   * Examples: "tvm:-239", ["tvm:-239", "tvm:-3"]
   */
  networks: Network | Network[];

  /**
   * Optional scheme configuration (e.g. facilitatorUrl)
   */
  schemeConfig?: ExactTvmSchemeConfig;
}

/**
 * Registers TVM exact payment schemes to an x402Facilitator instance.
 *
 * @param facilitator - The x402Facilitator instance to register schemes to
 * @param config - Configuration for TVM facilitator registration
 * @returns The facilitator instance for chaining
 *
 * @example
 * ```typescript
 * import { registerExactTvmScheme } from "@x402/tvm/exact/facilitator";
 * import { x402Facilitator } from "@x402/core/facilitator";
 *
 * const facilitator = new x402Facilitator();
 * registerExactTvmScheme(facilitator, {
 *   networks: "tvm:-239",
 *   schemeConfig: { facilitatorUrl: "https://facilitator.example.com" },
 * });
 * ```
 */
export function registerExactTvmScheme(
  facilitator: x402Facilitator,
  config: TvmFacilitatorConfig,
): x402Facilitator {
  facilitator.register(
    config.networks,
    new ExactTvmScheme(config.schemeConfig),
  );

  return facilitator;
}
