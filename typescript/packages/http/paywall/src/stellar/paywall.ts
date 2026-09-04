import type { PaymentRequired } from "../types";
import { getStellarTemplate } from "./template-loader";

/**
 * USDC Stellar Asset Contract ids, mirrored from `@x402/stellar` constants.
 * Kept inline so the server-side handler does not pull the Stellar SDK into
 * the resource server bundle.
 */
const USDC_PUBNET_ADDRESS = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const USDC_TESTNET_ADDRESS = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/**
 * Per-network USDC metadata exposed to the browser bundle as
 * `window.x402.config.chainConfig`, keyed by the CAIP-2 network reference.
 *
 * @returns Chain config map for Stellar pubnet and testnet
 */
function getChainConfig(): Record<string, { usdcAddress: string; usdcName: string }> {
  return {
    pubnet: { usdcAddress: USDC_PUBNET_ADDRESS, usdcName: "USDC" },
    testnet: { usdcAddress: USDC_TESTNET_ADDRESS, usdcName: "USDC" },
  };
}

/**
 * Serializes a value as JSON that is safe to embed inside an inline HTML
 * `<script>` block. `<` is escaped to `<` so a `</script>` sequence in
 * the data (for example in `resource.description`) cannot close the script
 * element. The output is still valid JavaScript.
 *
 * @param value - Any JSON-serializable value
 * @returns A JavaScript expression string
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

interface StellarPaywallOptions {
  amount: number;
  paymentRequired: PaymentRequired;
  currentUrl: string;
  testnet: boolean;
  appName?: string;
  appLogo?: string;
  faucetUrls?: Record<string, string>;
  stellarRpcUrl?: string;
}

/**
 * Generates Stellar-specific paywall HTML
 *
 * @param options - The options for generating the paywall
 * @param options.amount - The amount to be paid in whole token units
 * @param options.paymentRequired - The payment required response with accepts array
 * @param options.currentUrl - The URL of the content being accessed
 * @param options.testnet - Whether to use testnet or mainnet
 * @param options.appName - The name of the application to display in the wallet connection modal
 * @param options.appLogo - The logo of the application to display in the wallet connection modal
 * @param options.faucetUrls - Per-chain (CAIP-2 keyed) override for the testnet faucet link
 * @param options.stellarRpcUrl - Optional Soroban RPC URL override for the browser bundle
 * @returns HTML string for the paywall page
 */
export function getStellarPaywallHtml(options: StellarPaywallOptions): string {
  const STELLAR_PAYWALL_TEMPLATE = getStellarTemplate();

  if (!STELLAR_PAYWALL_TEMPLATE) {
    return `<!DOCTYPE html><html><body><h1>Stellar Paywall (run pnpm build:paywall to generate full template)</h1></body></html>`;
  }

  const {
    amount,
    testnet,
    paymentRequired,
    currentUrl,
    appName,
    appLogo,
    faucetUrls,
    stellarRpcUrl,
  } = options;

  const logOnTestnet = testnet
    ? "console.log('Stellar Payment required initialized:', window.x402);"
    : "";

  const rpcUrlLine = stellarRpcUrl ? `\n        rpcUrl: ${jsonForScript(stellarRpcUrl)},` : "";

  const configScript = `
  <script>
    window.x402 = {
      amount: ${amount},
      paymentRequired: ${jsonForScript(paymentRequired)},
      testnet: ${testnet},
      currentUrl: ${jsonForScript(currentUrl)},
      config: {${rpcUrlLine}
        chainConfig: ${jsonForScript(getChainConfig())},
      },
      appName: ${jsonForScript(appName || "")},
      appLogo: ${jsonForScript(appLogo || "")},
      faucetUrls: ${faucetUrls ? jsonForScript(faucetUrls) : "undefined"},
    };
    ${logOnTestnet}
  </script>`;

  return STELLAR_PAYWALL_TEMPLATE.replace("</head>", `${configScript}\n</head>`);
}
