/**
 * AVM Server Scheme for Exact Payment Protocol
 *
 * Parses prices and builds payment requirements for Algorand ASA transfers.
 */

import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { USDC_CONFIG, USDC_DECIMALS } from "../../constants";
import { convertToTokenAmount } from "../../utils";

/**
 * AVM server implementation for the Exact payment scheme.
 *
 * Handles price parsing and payment requirements enhancement for Algorand networks.
 */
export class ExactAvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   * Multiple parsers can be registered - they will be tried in registration order.
   * Each parser receives a decimal amount (e.g., 1.50 for $1.50).
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
   *   if (amount > 100) {
   *     return { amount: (amount * 1e6).toString(), asset: "12345678" };
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

    // Parse Money to decimal number
    const amount = this.parseMoneyToDecimal(price);

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // All custom parsers returned null, use default conversion
    return this.defaultMoneyConversion(amount, network);
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

    // Get USDC config for the network
    const usdcConfig = USDC_CONFIG[supportedKind.network];
    const decimals = usdcConfig?.decimals ?? USDC_DECIMALS;

    // Build enhanced requirements with feePayer and decimals
    const enhanced: PaymentRequirements = {
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        decimals,
      },
    };

    // Add feePayer from supportedKind.extra if provided
    if (supportedKind.extra?.feePayer) {
      enhanced.extra = {
        ...enhanced.extra,
        feePayer: supportedKind.extra.feePayer,
      };
    }

    return Promise.resolve(enhanced);
  }

  /**
   * Parse Money (string | number) to a decimal number.
   * Handles formats like "$1.50", "1.50", 1.50, etc.
   *
   * @param money - The money value to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    // Remove $ sign and whitespace, then parse
    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  /**
   * Default money conversion implementation.
   * Converts decimal amount to the default stablecoin (USDC) on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = this.getDefaultAsset(network);
    const tokenAmount = convertToTokenAmount(amount.toString(), assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.asaId,
    };
  }

  /**
   * Get the default asset info for a network (USDC)
   *
   * @param network - The network to get asset info for
   * @returns The asset information including ASA ID, name, and decimals
   */
  private getDefaultAsset(network: Network): {
    asaId: string;
    name: string;
    decimals: number;
  } {
    const assetInfo = USDC_CONFIG[network];
    if (!assetInfo) {
      throw new Error(`No default asset configured for network ${network}`);
    }

    return assetInfo;
  }
}
