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
 * Resolves the decimal precision for a payment requirement's token.
 *
 * Server-side we cannot read `decimals()` from the token contract, so we trust the
 * x402 default-asset registry only when the requirement's `asset` matches the
 * registered default token address for the network. For any other asset we fall
 * back to 6 (USDC standard) — the on-chain `decimals()` read on the client side
 * still produces the correct precision for balance display.
 *
 * @param requirement - The payment requirement whose amount needs scaling
 * @returns Decimal precision to use when formatting the displayed amount
 */
function getRequirementDecimals(requirement: PaymentRequirements): number {
  try {
    const defaultAsset = getDefaultAsset(requirement.network as Network);
    if (
      requirement.asset &&
      requirement.asset.toLowerCase() === defaultAsset.address.toLowerCase()
    ) {
      return defaultAsset.decimals;
    }
  } catch {
    // No default asset registered for this network; fall through to fallback.
  }
  return 6;
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
    const decimals = getRequirementDecimals(requirement);
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
