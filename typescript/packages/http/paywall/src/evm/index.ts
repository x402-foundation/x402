import { formatUnits } from "viem";
import type {
  PaywallNetworkHandler,
  PaymentRequirements,
  PaymentRequired,
  PaywallConfig,
} from "../types";
import { getEvmPaywallHtml } from "./paywall";
import { NETWORK_DECIMALS } from "./gen/decimals";

/**
 * Resolves the token decimals for a payment requirement by looking up the
 * network in the build-time-generated `NETWORK_DECIMALS` map. That map is
 * derived from `@x402/evm`'s `DEFAULT_STABLECOINS` (the same source the
 * scheme `getAssetDecimals` methods read from) and is regenerated via
 * `pnpm --filter @x402/paywall run build:paywall`. Falls back to 6 (USDC
 * default) when the network is unknown.
 *
 * @param requirement - The payment requirement
 * @returns The number of decimals for the payment token
 */
export function getDefaultTokenDecimals(requirement: PaymentRequirements): number {
  return NETWORK_DECIMALS[requirement.network] ?? 6;
}

/**
 * EVM paywall handler that supports EVM-based networks (CAIP-2 format only)
 */
export const evmPaywall: PaywallNetworkHandler = {
  /**
   * Check if this handler supports the given payment requirement
   *
   * @param requirement - Payment requirement to check
   * @returns True if this handler can process this requirement
   */
  supports(requirement: PaymentRequirements): boolean {
    return requirement.network.startsWith("eip155:");
  },

  /**
   * Generate EVM-specific paywall HTML
   *
   * @param requirement - The selected payment requirement
   * @param paymentRequired - Full payment required response
   * @param config - Paywall configuration
   * @returns HTML string for the paywall page
   */
  generateHtml(
    requirement: PaymentRequirements,
    paymentRequired: PaymentRequired,
    config: PaywallConfig,
  ): string {
    const decimals = getDefaultTokenDecimals(requirement);
    const atomic = requirement.amount ?? requirement.maxAmountRequired;
    // BigInt + formatUnits preserves precision through the conversion;
    // parseFloat collapses sub-cent digits on real 18-decimal amounts.
    const amount = atomic ? Number(formatUnits(BigInt(atomic), decimals)) : 0;

    return getEvmPaywallHtml({
      amount,
      paymentRequired,
      currentUrl: paymentRequired.resource?.url || config.currentUrl || "",
      testnet: config.testnet ?? true,
      appName: config.appName,
      appLogo: config.appLogo,
    });
  },
};
