import { toScriptJson } from "../scriptJson";
import type { PaymentRequirements as CorePaymentRequirements } from "@x402/core/types";
import type { PaymentRequired } from "../types";
import type { InjectedProtocolParameters } from "./protocolParams";
import { getCardanoTemplate } from "./template-loader";

/** Cardano-specific page configuration injected as `window.x402.cardano`. */
export interface CardanoPageConfig {
  /** The requirement the server chose; the page signs only this one. */
  selectedRequirement: CorePaymentRequirements;
  /** Canonical network id of the selected requirement. */
  network: string;
  /** Koios protocol parameters, or null while the server cache is cold. */
  protocolParameters: InjectedProtocolParameters | null;
  /** Server wall clock at render time (unix ms); anchors the payment TTL. */
  serverTimeMs: number;
}

/** Options for {@link getCardanoPaywallHtml}. */
export interface CardanoPaywallHtmlOptions {
  requirement: CorePaymentRequirements;
  network: string;
  paymentRequired: PaymentRequired;
  protocolParameters: InjectedProtocolParameters | null;
  serverTimeMs: number;
  currentUrl: string;
  testnet: boolean;
  appName?: string;
  appLogo?: string;
  faucetUrls?: Record<string, string>;
}

/**
 * Generates the Cardano paywall HTML. Every injected value goes through
 * `toScriptJson`, so seller-controlled strings cannot close the script tag.
 *
 * @param options - Selected requirement, parameters and page config.
 * @returns HTML string for the paywall page.
 */
export function getCardanoPaywallHtml(options: CardanoPaywallHtmlOptions): string {
  const template = getCardanoTemplate();
  if (!template) {
    return `<!DOCTYPE html><html><body><h1>Cardano Paywall (run pnpm build:paywall to generate full template)</h1></body></html>`;
  }

  const cardano: CardanoPageConfig = {
    selectedRequirement: options.requirement,
    network: options.network,
    protocolParameters: options.protocolParameters,
    serverTimeMs: options.serverTimeMs,
  };
  const x402 = {
    paymentRequired: options.paymentRequired,
    testnet: options.testnet,
    currentUrl: options.currentUrl,
    appName: options.appName ?? "",
    appLogo: options.appLogo ?? "",
    faucetUrls: options.faucetUrls,
    config: { chainConfig: {} },
    cardano,
  };
  const configScript = `
  <script>
    window.x402 = ${toScriptJson(x402)};
  </script>`;

  return template.replace("</head>", `${configScript}\n</head>`);
}
