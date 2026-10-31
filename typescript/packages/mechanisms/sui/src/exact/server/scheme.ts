import { normalizeStructTag } from "@mysten/sui/utils";
import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";

/**
 * Sui server implementation for the Exact payment scheme. Parses prices into
 * atomic USDC amounts and passes any operator-set `extra.nonce` through
 * untouched (auto-generating one would break requirement matching).
 */
export class ExactSuiScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
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

    const { amount, symbol } = parseMoney(price as Money);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Decimals for a known default asset, or undefined. Other assets must be
   * priced with an explicit AssetAmount in atomic units.
   *
   * @param asset - The asset coin type
   * @param network - The CAIP-2 network identifier
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
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

    try {
      this.assertPositiveAmount(paymentRequirements.amount);
    } catch (error) {
      return Promise.reject(error);
    }

    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Default money conversion to the network's default asset (USDC).
   *
   * @param amount - The decimal amount
   * @param network - The CAIP-2 network identifier
   * @param symbol - Optional ticker from a suffixed price
   * @returns The parsed asset amount
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);
    this.assertPositiveAmount(tokenAmount);
    return { amount: tokenAmount, asset: assetInfo.asset, extra: {} };
  }

  /**
   * Throw when an atomic-unit amount is not a positive integer.
   *
   * @param amount - The atomic-unit amount string
   */
  private assertPositiveAmount(amount: string): void {
    if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
      throw new Error(
        `invalid_payment_requirements: amount must be a positive integer, got ${amount}`,
      );
    }
  }
}
