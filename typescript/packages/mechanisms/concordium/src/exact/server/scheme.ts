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
 * Concordium server scheme for exact payments.
 *
 * Supports:
 * - Native CCD via explicit AssetAmount: { amount: "1000", asset: "CCD" }
 * - PLT tokens via explicit AssetAmount: { amount: "100", asset: "<token-id>" }
 * - Money (string/number) resolved to StablR USDR via {@link getDefaultAsset}
 * - {@link registerMoneyParser} for EURR and other PLTs (tried before the USDR default)
 */
export class ExactConcordiumScheme implements SchemeNetworkServer {
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
   * next parser. If all parsers return null, prices fall through to USDR.
   *
   * @param parser - Custom function returning AssetAmount or null
   * @returns This instance for chaining
   *
   * @example
   * ```typescript
   * scheme.registerMoneyParser(async (amount, network) => ({
   *   amount: convertToTokenAmount(String(amount), 6),
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
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - PLT token id from payment requirements
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Parse price into AssetAmount.
   *
   * - **AssetAmount**: passed through in atomic units. The `asset` field is
   *   required — throws if missing.
   * - **Money** (string | number): tries registered money parsers in order,
   *   then USDR via {@link getDefaultAsset}. Native CCD is never a silent fallback.
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

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) return result;
    }

    return this.defaultMoneyConversion(amount, network, symbol);
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
   * Default conversion when no custom parser handles the value.
   *
   * @param amount - Decimal amount
   * @param network - Network identifier
   * @param symbol - Optional ticker from a suffixed price
   * @returns Asset amount in USDR atomic units
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    return {
      amount: convertToTokenAmount(amount, assetInfo.decimals),
      asset: assetInfo.asset,
      extra: {},
    };
  }
}
