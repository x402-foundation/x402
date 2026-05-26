import type { PaymentRequired } from "../types";
import { getEvmTemplate } from "./template-loader";

/**
 * Escapes a string for safe injection into JavaScript string literals
 *
 * @param str - The string to escape
 * @returns The escaped string
 */
function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Gets the EVM chain config
 *
 * @returns The EVM chain config
 */
function getChainConfig() {
  return {
    base: {
      usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      usdcName: "USDC",
    },
    "base-sepolia": {
      usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      usdcName: "USDC",
    },
  };
}

interface EvmPaywallOptions {
  amount: number;
  paymentRequired: PaymentRequired;
  currentUrl: string;
  testnet: boolean;
  appName?: string;
  appLogo?: string;
  faucetUrls?: Record<string, string>;
}

/**
 * Generates EVM-specific paywall HTML
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
export function getEvmPaywallHtml(options: EvmPaywallOptions): string {
  const EVM_PAYWALL_TEMPLATE = getEvmTemplate();

  if (!EVM_PAYWALL_TEMPLATE) {
    return `<!DOCTYPE html><html><body><h1>EVM Paywall (run pnpm build:paywall to generate full template)</h1></body></html>`;
  }

  const { amount, testnet, paymentRequired, currentUrl, appName, appLogo, faucetUrls } = options;

  const logOnTestnet = testnet
    ? "console.log('EVM Payment required initialized:', window.x402);"
    : "";

  const config = getChainConfig();

  const configScript = `
  <script>
    window.x402 = {
      amount: ${amount},
      paymentRequired: ${JSON.stringify(paymentRequired)},
      testnet: ${testnet},
      currentUrl: "${escapeString(currentUrl)}",
      config: {
        chainConfig: ${JSON.stringify(config)},
      },
      appName: "${escapeString(appName || "")}",
      appLogo: "${escapeString(appLogo || "")}",
      faucetUrls: ${faucetUrls ? JSON.stringify(faucetUrls) : "undefined"},
    };
    ${logOnTestnet}
  </script>`;

  return EVM_PAYWALL_TEMPLATE.replace("</head>", `${configScript}\n</head>`);
}
