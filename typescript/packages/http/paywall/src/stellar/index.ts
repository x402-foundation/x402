import type {
  PaywallNetworkHandler,
  PaymentRequirements,
  PaymentRequired,
  PaywallConfig,
} from "../types";
import { getStellarPaywallHtml } from "./paywall";

/**
 * Stellar-specific paywall configuration. Extends the shared `PaywallConfig`
 * with an optional Soroban RPC URL override that the browser bundle uses for
 * balance lookups and transaction simulation. When omitted, `@x402/stellar`'s
 * default public RPC for the network is used.
 */
export interface StellarPaywallConfig extends PaywallConfig {
  stellarRpcUrl?: string;
}

/**
 * Number of decimal places used by Stellar Asset Contract (SAC) tokens such as
 * USDC. One unit is 10^7 stroops. Matches `DEFAULT_TOKEN_DECIMALS` in
 * `@x402/stellar`.
 */
export const STELLAR_TOKEN_DECIMALS = 7;

/**
 * Converts an atomic (stroop) amount string to a display number without
 * passing the raw integer through IEEE 754 first. The integer and fractional
 * parts are split with BigInt arithmetic so amounts above 2^53 stroops still
 * render their whole-unit part exactly.
 *
 * @param atomic - Atomic amount as an integer string (e.g. `"5100000"`)
 * @returns The amount in whole token units (e.g. `0.51`)
 * @throws If `atomic` is not an integer string
 */
export function stroopsToDisplayAmount(atomic: string): number {
  const raw = BigInt(atomic);
  const scale = 10n ** BigInt(STELLAR_TOKEN_DECIMALS);
  const whole = raw / scale;
  const fraction = raw % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}

/**
 * Stellar paywall handler that supports Stellar networks (CAIP-2 format only)
 */
export const stellarPaywall: PaywallNetworkHandler = {
  /**
   * Check if this handler supports the given payment requirement
   *
   * @param requirement - The payment requirement to check
   * @returns True if this handler can process this requirement
   */
  supports(requirement: PaymentRequirements): boolean {
    return requirement.network.startsWith("stellar:");
  },

  /**
   * Generate Stellar-specific paywall HTML
   *
   * @param requirement - The selected payment requirement
   * @param paymentRequired - Full payment required response
   * @param config - Paywall configuration (accepts `StellarPaywallConfig`)
   * @returns HTML string for the paywall page
   */
  generateHtml(
    requirement: PaymentRequirements,
    paymentRequired: PaymentRequired,
    config: PaywallConfig,
  ): string {
    const atomic = requirement.amount ?? requirement.maxAmountRequired;
    const amount = atomic ? stroopsToDisplayAmount(atomic) : 0;
    const { stellarRpcUrl } = config as StellarPaywallConfig;

    return getStellarPaywallHtml({
      amount,
      paymentRequired,
      currentUrl: paymentRequired.resource?.url || config.currentUrl || "",
      testnet: config.testnet ?? true,
      appName: config.appName,
      appLogo: config.appLogo,
      faucetUrls: config.faucetUrls,
      stellarRpcUrl,
    });
  },
};
