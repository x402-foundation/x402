import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset, type HederaDefaultAsset } from "../../defaultAssets";
import { assertSupportedHederaNetwork, isValidHederaAsset } from "../../utils";

/** HTS token used when converting Money strings on the resource server. */
export type HederaServerDefaultAsset = Pick<HederaDefaultAsset, "asset" | "decimals">;

/**
 * Server-side options for Hedera exact scheme.
 */
export type HederaServerConfig = {
  defaultAssets?: Record<string, HederaServerDefaultAsset>;
};

/**
 * Hedera server implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
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
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - HTS token id or HBAR asset id
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    const override = this.config.defaultAssets?.[network];
    if (override?.asset === asset) {
      return override.decimals;
    }
    return findDefaultAsset(asset, network)?.decimals;
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

    const { amount, symbol } = parseMoney(price as Money);

    for (const parser of this.moneyParsers) {
      const parsed = await parser(amount, network);
      if (parsed !== null) {
        return parsed;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
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
   * @param extensionKeys - Extension keys
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
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;
    const extra: Record<string, unknown> = { ...(paymentRequirements.extra || {}) };
    if (typeof supportedKind.extra?.feePayer === "string") {
      extra.feePayer = supportedKind.extra.feePayer;
    }
    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Default conversion when no custom parser handles the value.
   *
   * @param amount - Decimal amount
   * @param network - Hedera network
   * @param symbol - Optional ticker from a suffixed price
   * @returns AssetAmount in configured default HTS token
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const tokenConfig =
      this.config.defaultAssets?.[network] ??
      (() => {
        const assetInfo = getDefaultAsset(network, symbol);
        return { asset: assetInfo.asset, decimals: assetInfo.decimals };
      })();

    if (!isValidHederaAsset(tokenConfig.asset) || tokenConfig.asset === "0.0.0") {
      throw new Error("Default Hedera asset must be an HTS fungible token ID");
    }

    return {
      amount: convertToTokenAmount(amount, tokenConfig.decimals),
      asset: tokenConfig.asset,
      extra: {},
    };
  }
}
