import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { parseMoneyString } from "@x402/core/utils";
import { BSV_ASSET_IDENTIFIER, BSV_DECIMALS, MAX_SATOSHIS } from "../../constants";

/**
 * BSV server scheme for exact payments.
 *
 * Supports:
 * - Native satoshis via explicit AssetAmount: { amount: "1000", asset: "BSV" }
 * - Money (string/number) only when a money parser is registered
 *
 * There is no default asset fallback — raw numbers and USD strings will
 * throw unless a money parser (e.g. a USD→satoshi rate feed) is registered
 * via {@link registerMoneyParser}.
 */
export class ExactBsvScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;

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
   * scheme.registerMoneyParser(async (usd, network) => ({
   *   amount: String(Math.round((usd / await usdPerBsv()) * 1e8)),
   *   asset: "BSV",
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
   * - **AssetAmount**: passed through in atomic units (satoshis). The
   *   `asset` field is required — throws if missing.
   * - **Money** (string | number): tries registered money parsers in order.
   *   Throws if no parser matches — there is no silent BSV fallback because
   *   satoshis are not USD-denominated.
   *
   * @param price - Price to parse
   * @param network - Network identifier
   * @returns Parsed asset amount in atomic units
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // AssetAmount: pass-through atomic units, asset required and must be BSV
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset must be specified for AssetAmount on network ${network}`);
      }
      if (price.asset.toUpperCase() !== BSV_ASSET_IDENTIFIER) {
        throw new Error(
          `Unsupported asset "${price.asset}" on network ${network}: ` +
            `the BSV exact scheme transfers native ${BSV_ASSET_IDENTIFIER} (satoshis) only`,
        );
      }
      this.assertSatoshiAmount(price.amount, network);
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

    // No parser matched — throw, no silent satoshi fallback
    throw new Error(
      `Cannot resolve price "${String(price)}" to a BSV amount. ` +
        `Use an explicit AssetAmount ({ amount: "<satoshis>", asset: "BSV" }) ` +
        `or register a money parser via registerMoneyParser() to convert ` +
        `fiat prices to satoshis.`,
    );
  }

  /**
   * Returns the number of decimals for the given asset.
   *
   * @param asset - Asset identifier (only native BSV is supported)
   * @param _ - Network identifier (unused)
   * @returns 8 — satoshis per BSV
   */
  getAssetDecimals(asset: string, _: Network): number {
    if (asset !== "" && asset.toUpperCase() !== BSV_ASSET_IDENTIFIER) {
      throw new Error(`Unknown BSV asset: ${asset}`);
    }
    return BSV_DECIMALS;
  }

  /**
   * Enhances payment requirements with facilitator-announced metadata.
   *
   * BSV has no fee sponsorship (clients fund and fee their own
   * transactions), so this only defaults the asset identifier and merges
   * any facilitator-announced `extra` metadata.
   *
   * @param requirements - Payment requirements to enhance
   * @param supportedKind - Supported payment kind configuration
   * @param supportedKind.x402Version - X402 protocol version
   * @param supportedKind.scheme - Payment scheme identifier
   * @param supportedKind.network - Network identifier
   * @param supportedKind.extra - Extra facilitator metadata
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
      asset: requirements.asset || BSV_ASSET_IDENTIFIER,
      extra: {
        ...((requirements.extra as Record<string, unknown>) ?? {}),
        ...(supportedKind.extra ?? {}),
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
    return Number(parseMoneyString(money));
  }

  /**
   * Validates an explicit satoshi amount is a positive integer within the
   * representable supply, so malformed amounts fail at parse time rather
   * than shipping in a 402 challenge.
   *
   * @param amount - The atomic-unit amount string
   * @param network - Network identifier (for the error message)
   */
  private assertSatoshiAmount(amount: string, network: Network): void {
    if (!/^\d+$/.test(amount)) {
      throw new Error(
        `Invalid BSV amount "${amount}" on network ${network}: must be a positive integer number of satoshis`,
      );
    }
    const satoshis = BigInt(amount);
    if (satoshis <= 0n || satoshis > BigInt(MAX_SATOSHIS)) {
      throw new Error(
        `BSV amount "${amount}" on network ${network} is out of range (1..${MAX_SATOSHIS} satoshis)`,
      );
    }
  }
}
