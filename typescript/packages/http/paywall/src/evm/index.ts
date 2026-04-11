import type { Network } from "@x402/core/types";
import { formatUnits } from "viem";
import type {
  PaywallNetworkHandler,
  PaymentRequirements,
  PaymentRequired,
  PaywallConfig,
} from "../types";
import { getEvmPaywallHtml } from "./paywall";
import { getDefaultAsset } from "../../../../mechanisms/evm/src/shared/defaultAssets";

function getRequirementDecimals(requirement: PaymentRequirements): number {
  const decimals = requirement.extra?.decimals;
  if (typeof decimals === "number") {
    return decimals;
  }

  try {
    return getDefaultAsset(requirement.network as Network).decimals;
  } catch {
    return 6;
  }
}

function getDisplayAmount(rawAmount: string | undefined, decimals: number): number {
  if (!rawAmount) {
    return 0;
  }

  try {
    return Number(formatUnits(BigInt(rawAmount), decimals));
  } catch {
    return parseFloat(rawAmount) / 10 ** decimals;
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
    const decimals = getRequirementDecimals(requirement);
    const amount = getDisplayAmount(requirement.amount ?? requirement.maxAmountRequired, decimals);

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
