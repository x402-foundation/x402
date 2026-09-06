/**
 * Configuration options for the paywall
 */
export interface PaywallConfig {
  appName?: string;
  appLogo?: string;
  currentUrl?: string;
  testnet?: boolean;
  /**
   * Per-chain override for the testnet faucet link, keyed by CAIP-2 network
   * identifier (e.g. `"eip155:84532"`, `"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"`).
   *
   * Wins over the paywall's curated `FAUCET_URLS` map for the matching chain.
   * When neither this override nor the curated map has an entry, the paywall
   * renders "No faucet configured." instead of a fallback link.
   */
  faucetUrls?: Record<string, string>;
}

/**
 * Payment requirements structure (supports both v1 and v2)
 */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
  // V1 fields
  maxAmountRequired?: string;
  description?: string;
  resource?: string;
  mimeType?: string;
  // V2 fields
  amount?: string;
}

/**
 * Payment required response structure
 */
export interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/**
 * Paywall provider interface for generating HTML
 */
export interface PaywallProvider {
  /**
   * Generate HTML for a payment required response
   *
   * @param paymentRequired - Payment required response with accepts array
   * @param config - Optional runtime configuration
   * @returns HTML string for the paywall page
   */
  generateHtml(paymentRequired: PaymentRequired, config?: PaywallConfig): string;
}

/**
 * Network-specific paywall handler
 */
export interface PaywallNetworkHandler {
  /**
   * Check if this handler supports the given payment requirement
   *
   * @param requirement - Payment requirement to check
   * @returns True if this handler can process this requirement
   */
  supports(requirement: PaymentRequirements): boolean;

  /**
   * Generate HTML for this network's paywall
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
  ): string;
}
