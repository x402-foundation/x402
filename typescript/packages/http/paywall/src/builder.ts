import type {
  PaywallConfig,
  PaywallProvider,
  PaymentRequired,
  PaywallNetworkHandler,
} from "./types";

/**
 * Builder for creating configured paywall providers
 */
export class PaywallBuilder {
  private config: PaywallConfig = {};
  private handlers: PaywallNetworkHandler[] = [];

  /**
   * Register a network-specific paywall handler
   *
   * @param handler - Network handler to register
   * @returns This builder instance for chaining
   */
  withNetwork(handler: PaywallNetworkHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /**
   * Set configuration options for the paywall
   *
   * @param config - Paywall configuration options
   * @returns This builder instance for chaining
   */
  withConfig(config: PaywallConfig): this {
    this.config = { ...this.config, ...config };
    return this;
  }

  /**
   * Build the paywall provider
   *
   * @returns A configured PaywallProvider instance
   */
  build(): PaywallProvider {
    const builderConfig = this.config;
    const handlers = this.handlers;

    return {
      generateHtml: (paymentRequired: PaymentRequired, runtimeConfig?: PaywallConfig): string => {
        // Merge builder config with runtime config (runtime takes precedence)
        const finalConfig = { ...builderConfig, ...runtimeConfig };

        if (handlers.length === 0) {
          throw new Error(
            "No paywall handlers registered. Use .withNetwork(evmPaywall) or .withNetwork(svmPaywall)",
          );
        }

        for (const requirement of paymentRequired.accepts) {
          const handler = handlers.find(h => h.supports(requirement));
          if (handler) {
            return handler.generateHtml(requirement, paymentRequired, finalConfig);
          }
        }

        const networks = paymentRequired.accepts.map(r => r.network).join(", ");
        throw new Error(
          `No paywall handler supports networks: ${networks}. Register appropriate handlers with .withNetwork()`,
        );
      },
    };
  }
}

/**
 * Create a new paywall builder
 *
 * @returns A new PaywallBuilder instance
 */
export function createPaywall(): PaywallBuilder {
  return new PaywallBuilder();
}
