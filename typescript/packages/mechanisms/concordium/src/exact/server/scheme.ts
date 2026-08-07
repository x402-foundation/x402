import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { parseMoneyString } from "@x402/core/utils";

/**
 * Concordium server scheme for exact payments.
 *
 * Supports:
 * - Native CCD via explicit AssetAmount: { amount: "1000", asset: "CCD" }
 * - PLT tokens via explicit AssetAmount: { amount: "100", asset: "<token-id>" }
 * - Money (string/number) only when a money parser is registered
 *
 * There is no default asset fallback — raw numbers and USD strings
 * will throw unless a money parser is registered via {@link registerMoneyParser}.
 */
export class ExactConcordiumScheme implements SchemeNetworkServer {
  readonly scheme = "exact";

  /** Custom money parser chain — tried in registration order */
  private moneyParsers: MoneyParser[] = [];

  /**
   * Registers a custom money parser in the parser chain.
   *
   * Parsers are tried in registration order. Return `null` to skip to the
   * next parser. There is no default fallback — if all parsers return null,
   * {@link parsePrice} throws.
   *
   * @param parser - Custom function returning AssetAmount or null
   * @returns This instance for chaining
   *
   * @example
   * ```typescript
   * scheme.registerMoneyParser(async (amount, network) => ({
   *   amount: String(Math.round(amount * 1e6)),
   *   asset: "EURR",
   *   extra: {},
   * }));
   * ```
   */
  registerMoneyParser(parser: MoneyParser): this {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse price into AssetAmount.
   *
   * - **AssetAmount**: passed through in atomic units. The `asset` field is
   *   required — throws if missing.
   * - **Money** (string | number): tries registered money parsers in order.
   *   Throws if no parser matches — there is no silent CCD fallback.
   *
   * @param price - Price to parse
   * @param network - Network identifier
   * @returns Parsed asset amount in atomic units
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // AssetAmount: pass-through atomic units, asset required
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra ?? {},
      };
    }

    // Money: parse to decimal, try registered parsers
    const amount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }

    // No parser matched — throw, no silent CCD fallback
    throw new Error(
      `Cannot resolve price "${String(price)}" to a Concordium asset. ` +
        `Register a money parser via registerMoneyParser() to map prices ` +
        `to a specific token (e.g., EURR, USDR).`,
    );
  }

  /**
   * Enhance payment requirements with facilitator-announced fee payer metadata.
   *
   * The facilitator provides its address as the fee payer for transaction fees
   * via `supportedKind.extra.feePayer`. This method injects that into the
   * payment requirements so the client knows who will sponsor gas.
   *
   * @param requirements - Payment requirements to enhance
   * @param supportedKind - Supported payment kind configuration
   * @param supportedKind.x402Version - X402 protocol version
   * @param supportedKind.scheme - Payment scheme identifier
   * @param supportedKind.network - Network identifier
   * @param supportedKind.extra - Extra facilitator metadata (includes feePayer)
   * @param _ - Extension keys to apply (unused)
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    _: string[],
  ): Promise<PaymentRequirements> {
    return Promise.resolve({
      ...requirements,
      extra: {
        ...((requirements.extra as Record<string, unknown>) ?? {}),
        feePayer: supportedKind.extra?.feePayer,
      },
    });
  }

  /**
   * Parses Money (string | number) to a plain decimal number.
   *
   * @param money - Raw price to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") return money;
    return parseMoneyString(money);
  }
}
