import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { isNearNetwork } from "../../constants";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";

/**
 * Supported-kind shape passed to `enhancePaymentRequirements` (mirrors the core
 * `SupportedKind`, which is not re-exported from `@x402/core/types`).
 */
type SupportedKindLike = {
  x402Version: number;
  scheme: string;
  network: Network;
  extra?: Record<string, unknown>;
};

/**
 * Server-side NEAR exact-scheme implementation.
 */
export class ExactNearScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private readonly moneyParsers: MoneyParser[] = [];

  /**
   * Registers a custom money parser in front of default conversion.
   *
   * @param parser - Parser that can return an AssetAmount or null to continue chain
   * @returns Scheme instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactNearScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Converts a configured route price to amount/asset for NEAR.
   *
   * @param price - Price configuration
   * @param network - Target network
   * @returns Parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isNearNetwork(network)) {
      throw new Error(`Unsupported NEAR network: ${network}`);
    }

    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error("Asset is required when specifying amount explicitly");
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const parsed = await parser(amount, network);
      if (parsed !== null) {
        return parsed;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Returns payment requirements unchanged.
   *
   * NEAR exact payments carry no scheme-specific `extra`: the relayer is
   * facilitator-local configuration and MUST NOT be surfaced in the
   * client-facing `PaymentRequirements` (spec §3).
   *
   * @param paymentRequirements - Base requirements
   * @param supportedKind - Matching supported kind (unused)
   * @param extensionKeys - Facilitator extension keys (unused)
   * @returns Unchanged requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKindLike,
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    // Mark unused parameters to satisfy the linter.
    void supportedKind;
    void extensionKeys;
    return Promise.resolve(paymentRequirements);
  }

  /**
   * Default conversion when no custom parser handles the value.
   *
   * @param amount - Decimal amount
   * @param network - Network identifier
   * @param symbol - Optional ticker from a suffixed price
   * @returns Asset amount in the configured default NEP-141 token
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {},
    };
  }
}
