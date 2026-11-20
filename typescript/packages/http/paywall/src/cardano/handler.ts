import type { PaymentRequirements as CorePaymentRequirements } from "@x402/core/types";

import type {
  PaywallNetworkHandler,
  PaymentRequirements,
  PaymentRequired,
  PaywallConfig,
} from "../types";
import { getCardanoPaywallHtml } from "./paywall";
import {
  canonicalCardanoNetwork,
  KoiosProtocolParamsCache,
  type KoiosProtocolParamsOptions,
} from "./protocolParams";

/** A Cardano paywall handler with an explicit cache warm-up. */
export interface CardanoPaywallHandler extends PaywallNetworkHandler {
  /**
   * Fetches protocol parameters ahead of the first visitor. Call it at server
   * start, especially on serverless platforms where every instance starts cold.
   *
   * @param networks - Networks to warm; defaults to mainnet, preprod and preview.
   * @returns Resolves when the fetches settled.
   */
  prefetch(networks?: string[]): Promise<void>;
}

/**
 * Whether a requirement is a v2 requirement with a positive integer `amount`, i.e. the
 * shape the page signs.
 *
 * @param requirement - Requirement from the 402 response.
 * @returns True when the requirement can be handed to the page.
 */
function hasV2Amount(
  requirement: PaymentRequirements,
): requirement is PaymentRequirements & CorePaymentRequirements {
  return typeof requirement.amount === "string" && /^[1-9][0-9]*$/.test(requirement.amount);
}

/**
 * Creates a Cardano paywall handler (see `createCardanoPaywall`).
 *
 * @param options - Koios options, including the test-only clock.
 * @returns The handler.
 */
export function createCardanoPaywallHandler(
  options: KoiosProtocolParamsOptions = {},
): CardanoPaywallHandler {
  const cache = new KoiosProtocolParamsCache(options);
  const now = options.now ?? (() => Date.now());

  return {
    /**
     * Check if this handler supports the given payment requirement. As a side
     * effect, starts warming the protocol-parameter cache for its network
     * (never blocks).
     *
     * @param requirement - The payment requirement to check
     * @returns True for Cardano exact default-method requirements with an amount
     */
    supports(requirement: PaymentRequirements): boolean {
      const network = canonicalCardanoNetwork(requirement.network);
      const method = requirement.extra?.assetTransferMethod;
      const supported =
        network !== undefined &&
        requirement.scheme === "exact" &&
        (method === undefined || method === "default") &&
        hasV2Amount(requirement);
      if (supported) cache.get(requirement.network);
      return supported;
    },

    /**
     * Generate Cardano-specific paywall HTML
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
      if (!hasV2Amount(requirement)) {
        throw new Error(
          "The Cardano paywall needs a v2 requirement with a positive integer amount",
        );
      }
      const network = canonicalCardanoNetwork(requirement.network) ?? requirement.network;
      return getCardanoPaywallHtml({
        requirement,
        network,
        paymentRequired,
        protocolParameters: cache.get(requirement.network),
        serverTimeMs: now(),
        currentUrl: paymentRequired.resource?.url || config.currentUrl || "",
        testnet: config.testnet ?? true,
        appName: config.appName,
        appLogo: config.appLogo,
        faucetUrls: config.faucetUrls,
      });
    },

    prefetch(networks?: string[]): Promise<void> {
      return cache.prefetch(networks);
    },
  };
}
