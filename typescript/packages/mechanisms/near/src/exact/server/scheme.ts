import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString, parseMoneyString } from "@x402/core/utils";
import { DEFAULT_ASSET_BY_NETWORK, DEFAULT_TOKEN_DECIMALS, isNearNetwork } from "../../constants";

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

    const decimal = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const parsed = await parser(decimal, network);
      if (parsed !== null) {
        return parsed;
      }
    }

    const tokenAmount = convertToTokenAmount(
      numberToDecimalString(decimal),
      DEFAULT_TOKEN_DECIMALS,
    );
    const asset = this.defaultAssetForNetwork(network);

    return {
      amount: tokenAmount,
      asset,
      extra: {},
    };
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
   * Parses money-like value into decimal number.
   *
   * @param money - Money value
   * @returns Decimal amount
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      if (!Number.isFinite(money) || money < 0) {
        throw new Error(`Invalid money format: ${money}`);
      }
      return money;
    }

    return parseMoneyString(money);
  }

  /**
   * Resolves default asset for known NEAR networks.
   *
   * @param network - Network identifier
   * @returns Default NEP-141 asset id
   */
  private defaultAssetForNetwork(network: Network): string {
    if (network === "near:mainnet") {
      return DEFAULT_ASSET_BY_NETWORK["near:mainnet"];
    }
    if (network === "near:testnet") {
      return DEFAULT_ASSET_BY_NETWORK["near:testnet"];
    }
    throw new Error(`No default NEAR asset configured for network: ${network}`);
  }
}
