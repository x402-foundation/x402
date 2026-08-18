/**
 * AVM Server Scheme for Exact Payment Protocol
 *
 * Parses prices and builds payment requirements for Algorand ASA transfers.
 */

import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";

/**
 * AVM server implementation for the Exact payment scheme.
 *
 * Handles price parsing and payment requirements enhancement for Algorand networks.
 */
export class ExactAvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   * Multiple parsers can be registered - they will be tried in registration order.
   * Each parser receives a decimal string (e.g., "1.50" for $1.50).
   * If a parser returns null, the next parser in the chain will be tried.
   * The default parser is always the final fallback.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The server instance for chaining
   *
   * @example
   * ```typescript
   * avmServer.registerMoneyParser(async (amount, network) => {
   *   // Custom conversion logic for non-USDC assets
   *   if (Number(amount) > 100) {
   *     return { amount: convertToTokenAmount(String(amount), 6), asset: "12345678" };
   *   }
   *   return null; // Use next parser
   * });
   * ```
   */
  registerMoneyParser(parser: MoneyParser): ExactAvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - ASA id or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Parses a price into an asset amount.
   * If price is already an AssetAmount, returns it directly.
   * If price is Money (string | number), parses to decimal and tries custom parsers.
   * Falls back to default conversion if all custom parsers return null.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns Promise that resolves to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, return it directly
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset ID must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // All custom parsers returned null, use default conversion
    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from facilitator (contains extra data like feePayer)
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The logical payment scheme
   * @param supportedKind.network - The network identifier in CAIP-2 format
   * @param supportedKind.extra - Optional extra metadata (e.g., feePayer address)
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Payment requirements ready to be sent to clients
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    // Mark unused parameter
    void extensionKeys;

    // Add feePayer from supportedKind.extra if provided
    if (!supportedKind.extra?.feePayer) {
      return Promise.resolve(paymentRequirements);
    }

    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        feePayer: supportedKind.extra.feePayer,
      },
    });
  }

  /**
   * Default money conversion implementation.
   * Converts decimal amount to the default stablecoin (USDC) on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @param symbol - Optional ticker from a suffixed price
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
    };
  }
}
