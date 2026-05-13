import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount } from "@x402/core/utils";
import { assertSupportedHederaNetwork, isValidHederaAsset } from "../../utils";
import {
  HEDERA_MAINNET_CAIP2,
  HEDERA_TESTNET_CAIP2,
  HEDERA_MAINNET_USDC,
  HEDERA_TESTNET_USDC,
  HEDERA_USDC_DECIMALS,
} from "../../constants";

/**
 * Default token config used for Money parsing fallback.
 */
export type HederaDefaultAssetConfig = {
  asset: string;
  decimals: number;
};

/**
 * Server-side options for Hedera exact scheme.
 */
export type HederaServerConfig = {
  defaultAssets?: Record<string, HederaDefaultAssetConfig>;
};

/**
 * Hedera server implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Creates a new server scheme.
   *
   * @param config - Optional server config
   */
  constructor(private readonly config: HederaServerConfig = {}) {}

  /**
   * Register a custom money parser in order.
   *
   * @param parser - Money parser callback
   * @returns Scheme instance
   */
  registerMoneyParser(parser: MoneyParser): ExactHederaScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse Money/AssetAmount into exact payment amount + asset.
   *
   * @param price - Price input
   * @param network - Hedera network
   * @returns Asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    assertSupportedHederaNetwork(network);

    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset || !isValidHederaAsset(price.asset)) {
        throw new Error(`Invalid Hedera asset identifier: ${price.asset}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const amount = this.parseMoneyToDecimal(price as Money);

    for (const parser of this.moneyParsers) {
      const parsed = await parser(amount, network);
      if (parsed !== null) {
        return parsed;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Merge facilitator-provided values into payment requirements.
   *
   * @param paymentRequirements - Base requirements
   * @param supportedKind - Supported kind metadata
   * @param supportedKind.x402Version - x402 protocol version
   * @param supportedKind.scheme - Payment scheme identifier
   * @param supportedKind.network - Network identifier
   * @param supportedKind.extra - Additional metadata from facilitator supported kinds
   * @param facilitatorExtensions - Extension keys
   * @returns Enhanced requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    void facilitatorExtensions;
    const extra: Record<string, unknown> = { ...(paymentRequirements.extra || {}) };
    if (typeof supportedKind.extra?.feePayer === "string") {
      extra.feePayer = supportedKind.extra.feePayer;
    }
    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Parse flexible money value into decimal number.
   *
   * @param money - Money input
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }
    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);
    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }
    return amount;
  }

  /**
   * Default conversion when no custom parser handles the value.
   *
   * @param amount - Decimal amount
   * @param network - Hedera network
   * @returns AssetAmount in configured default HTS token
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const tokenConfig = this.config.defaultAssets?.[network] ?? this.getBuiltInDefault(network);
    if (!tokenConfig) {
      throw new Error(
        `No default HTS asset configured for network ${network}. Configure defaultAssets or provide explicit AssetAmount.`,
      );
    }
    if (!isValidHederaAsset(tokenConfig.asset) || tokenConfig.asset === "0.0.0") {
      throw new Error("Default Hedera asset must be an HTS fungible token ID");
    }

    return {
      amount: convertToTokenAmount(amount.toString(), tokenConfig.decimals),
      asset: tokenConfig.asset,
      extra: {},
    };
  }

  /**
   * Returns the built-in default asset config for known Hedera networks.
   *
   * @param network - CAIP-2 network identifier
   * @returns Default asset config or undefined for unknown networks
   */
  private getBuiltInDefault(network: Network): HederaDefaultAssetConfig | undefined {
    switch (network) {
      case HEDERA_MAINNET_CAIP2:
        return { asset: HEDERA_MAINNET_USDC, decimals: HEDERA_USDC_DECIMALS };
      case HEDERA_TESTNET_CAIP2:
        return { asset: HEDERA_TESTNET_USDC, decimals: HEDERA_USDC_DECIMALS };
      default:
        return undefined;
    }
  }
}
