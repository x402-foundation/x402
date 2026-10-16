import type { PaymentRequired } from "@x402/core/types";
import type { CardanoPageConfig } from "./cardano/paywall";

declare global {
  interface Window {
    /** CIP-30 wallets injected by browser extensions (read by the Cardano page). */
    cardano?: unknown;
    x402: {
      amount?: number;
      testnet?: boolean;
      paymentRequired: PaymentRequired;
      currentUrl: string;
      appName?: string;
      appLogo?: string;
      faucetUrls?: Record<string, string>;
      rpcUrls?: Record<string, string>;
      cardano?: CardanoPageConfig;
      config: {
        chainConfig: Record<
          string,
          {
            usdcAddress: string;
            usdcName: string;
          }
        >;
      };
    };
  }
}
