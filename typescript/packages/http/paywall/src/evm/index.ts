import { getDefaultAsset } from "@x402/evm";
import type { Network } from "@x402/core/types";
import type {
  PaywallNetworkHandler,
  PaymentRequirements,
  PaymentRequired,
  PaywallConfig,
} from "../types";
import { getEvmPaywallHtml } from "./paywall";

/**
 * Resolves the decimal precision for the payment token of a given EVM network.
 * Falls back to 6 (USDC standard) when the network has no default asset registered.
 *
 * @param network - CAIP-2 EVM network identifier (e.g. "eip155:8453")
 * @returns Decimal precision for the network's default payment asset
 */
function getNetworkDecimals(network: string): number {
  try {
    return getDefaultAsset(network as Network).decimals;
  } catch {
    return 6;
  }
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
    const decimals = getNetworkDecimals(requirement.network);
    const divisor = 10 ** decimals;
    const amount = requirement.amount
      ? parseFloat(requirement.amount) / divisor
      : requirement.maxAmountRequired
        ? parseFloat(requirement.maxAmountRequired) / divisor
        : 0;

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
