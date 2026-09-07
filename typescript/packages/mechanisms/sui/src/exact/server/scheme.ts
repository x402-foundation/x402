import { normalizeStructTag } from "@mysten/sui/utils";
import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { parseMoneyString } from "@x402/core/utils";
import { getUsdcCoinType, USDC_DECIMALS, USDC_MAINNET, USDC_TESTNET } from "../../constants";

/**
 * Sui server implementation for the Exact payment scheme. Parses prices into
 * atomic USDC amounts and passes any operator-set `extra.nonce` through
 * untouched (auto-generating one would break requirement matching).
 */
export class ExactSuiScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain. Parsers run in
   * registration order; returning null falls through to the next. The default
   * USDC conversion is the final fallback.
   *
   * @param parser - Custom function to convert an amount to an AssetAmount (or null to skip)
   * @returns The scheme instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactSuiScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse a price into an asset amount. An AssetAmount passes through
   * (validated as a coin type); Money is parsed to a decimal, offered to
   * custom parsers, then converted to USDC on the network.
   *
   * @param price - The price to parse
   * @param network - The CAIP-2 network identifier
   * @returns Promise resolving to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset must be specified for AssetAmount on network ${network}`);
      }
      normalizeStructTag(price.asset); // throws on a malformed coin type
      this.assertPositiveAmount(price.amount);
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }

    const amount = this.parseMoneyToDecimal(price as Money);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Return the decimal precision of an asset. Only USDC is known; other assets
   * must be priced with an explicit AssetAmount in atomic units.
   *
   * @param asset - The asset coin type
   * @param network - The CAIP-2 network identifier (unused)
   * @returns Number of decimal places
   */
  getAssetDecimals(asset: string, network: Network): number {
    void network;
    const normalized = normalizeStructTag(asset);
    if (
      normalized === normalizeStructTag(USDC_MAINNET) ||
      normalized === normalizeStructTag(USDC_TESTNET)
    ) {
      return USDC_DECIMALS;
    }
    throw new Error(
      `Unknown decimals for asset ${asset}; price it with an explicit AssetAmount in atomic units`,
    );
  }

  /**
   * Build payment requirements: merge the facilitator's advertised extras
   * (e.g. `feePayer`) and reject a non-positive amount.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from the facilitator's /supported endpoint
   * @param facilitatorExtensions - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    void facilitatorExtensions;

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      ...supportedKind.extra,
    };

    if (BigInt(paymentRequirements.amount) <= 0n) {
      return Promise.reject(
        new Error(
          `invalid_payment_requirements: amount must be positive, got ${paymentRequirements.amount}`,
        ),
      );
    }

    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Parse Money to a decimal number.
   *
   * @param money - The money value to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    return parseMoneyString(money);
  }

  /**
   * Default money conversion — to atomic USDC on the network.
   *
   * @param amount - The decimal amount
   * @param network - The CAIP-2 network identifier
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const tokenAmount = this.convertToTokenAmount(amount.toString(), USDC_DECIMALS);
    this.assertPositiveAmount(tokenAmount);
    return { amount: tokenAmount, asset: getUsdcCoinType(network), extra: {} };
  }

  /**
   * Throw when an atomic-unit amount is not a positive integer.
   *
   * @param amount - The atomic-unit amount string
   */
  private assertPositiveAmount(amount: string): void {
    if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error(`Amount must be a positive atomic-unit integer: ${amount}`);
    }
  }

  /**
   * Convert a decimal amount string to atomic units.
   *
   * @param amount - The decimal amount
   * @param decimals - Number of decimals for the token
   * @returns The amount in atomic units as a string
   */
  private convertToTokenAmount(amount: string, decimals: number): string {
    const parts = amount.split(".");
    const wholePart = parts[0] || "0";
    const fractionalPart = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    return BigInt(wholePart + fractionalPart).toString();
  }
}
