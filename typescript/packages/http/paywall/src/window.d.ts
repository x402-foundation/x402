import type { PaymentRequired } from "@x402/core/types";

declare global {
  interface Window {
    x402: {
      amount?: number;
      testnet?: boolean;
      paymentRequired: PaymentRequired;
      currentUrl: string;
      appName?: string;
      appLogo?: string;
      faucetUrls?: Record<string, string>;
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
