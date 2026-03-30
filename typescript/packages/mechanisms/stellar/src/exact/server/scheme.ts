import { DEFAULT_TOKEN_DECIMALS } from "../../constants";
import { convertToTokenAmount, getUsdcAddress } from "../../utils";
import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";

/**
 * Stellar server implementation for the Exact payment scheme.
 */
export class ExactStellarScheme implements SchemeNetworkServer {
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
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactStellarScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parses a price into `AssetAmount`.
   * If price is already an `AssetAmount`, returns it directly.
   * If price is `Money` (string | number), parses to decimal and tries custom parsers.
   * If no custom parsers return a valid `AssetAmount`, falls back to default conversion, assuming USDC token contract.
   *
   * @param price - The `Price` to parse
   * @param network - The `Network` to use
   * @returns Promise that resolves to the parsed `AssetAmount`
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // Attempt 1: if already an AssetAmount, return it directly
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    // Parse Money to decimal number
    const amount = this.parseMoneyToDecimal(price);

    // Attempt 2: try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // Attempt 3: fallback to default conversion, assuming USDC token contract.
    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind configuration
   * @param supportedKind.x402Version - The x402 protocol version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Extra metadata including `areFeesSponsored` from facilitator
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements with `areFeesSponsored` in extra
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
    // Mark unused parameters to satisfy linter
    void extensionKeys;

    // Add `areFeesSponsored` from supportedKind.extra to payment requirements
    // The facilitator provides `areFeesSponsored` which clients use to determine if fees are sponsored
    const areFeesSponsored = supportedKind.extra?.areFeesSponsored;
    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        ...(typeof areFeesSponsored === "boolean" && { areFeesSponsored }),
      },
    });
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
   * Converts decimal amount to USDC on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    // Convert decimal amount to token amount (USDC on Stellar has 7 decimals)
    const tokenAmount = convertToTokenAmount(amount.toString(), DEFAULT_TOKEN_DECIMALS);

    return {
      amount: tokenAmount,
      asset: getUsdcAddress(network),
      extra: {},
    };
  }
}
