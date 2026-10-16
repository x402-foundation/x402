import type { PaymentRequired } from "../types";
import { getAvmTemplate } from "./template-loader";
import { toScriptJson } from "../scriptJson";

interface AvmPaywallOptions {
  amount: number;
  paymentRequired: PaymentRequired;
  currentUrl: string;
  testnet: boolean;
  appName?: string;
  appLogo?: string;
  faucetUrls?: Record<string, string>;
}

/**
 * Generates AVM-specific paywall HTML
 *
 * @param options - The options for generating the paywall
 * @param options.amount - The amount to be paid in USD
 * @param options.paymentRequired - The payment required response with accepts array
 * @param options.currentUrl - The URL of the content being accessed
 * @param options.testnet - Whether to use testnet or mainnet
 * @param options.appName - The name of the application to display in the wallet connection modal
 * @param options.appLogo - The logo of the application to display in the wallet connection modal
 * @param options.faucetUrls - Per-chain (CAIP-2 keyed) override for the testnet faucet link
 * @returns HTML string for the paywall page
 */
export function getAvmPaywallHtml(options: AvmPaywallOptions): string {
  const AVM_PAYWALL_TEMPLATE = getAvmTemplate();

  if (!AVM_PAYWALL_TEMPLATE) {
    return `<!DOCTYPE html><html><body><h1>AVM Paywall (run pnpm build:paywall to generate full template)</h1></body></html>`;
  }

  const { amount, testnet, paymentRequired, currentUrl, appName, appLogo, faucetUrls } = options;

  const logOnTestnet = testnet
    ? "console.log('AVM Payment required initialized:', window.x402);"
    : "";

  const configScript = `
  <script>
    window.x402 = {
      amount: ${amount},
      paymentRequired: ${toScriptJson(paymentRequired)},
      testnet: ${testnet},
      currentUrl: ${toScriptJson(currentUrl)},
      config: {
        chainConfig: {},
      },
      appName: ${toScriptJson(appName || "")},
      appLogo: ${toScriptJson(appLogo || "")},
      faucetUrls: ${faucetUrls ? toScriptJson(faucetUrls) : "undefined"},
    };
    ${logOnTestnet}
  </script>`;

  return AVM_PAYWALL_TEMPLATE.replace("</head>", `${configScript}\n</head>`);
}
