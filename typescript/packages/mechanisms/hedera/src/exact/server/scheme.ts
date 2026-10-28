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
import { SDK_DEFAULT_ASSET_TRANSFER_METHOD } from "@x402/core/server";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import {
  HEDERA_DEFAULT_ASSET_TRANSFER_METHOD,
  HEDERA_TRANSFER_EXECUTOR_METHOD,
} from "../../constants";
import { findDefaultAsset, getDefaultAsset, type HederaDefaultAsset } from "../../defaultAssets";
import { executorListAdmits, hasSplits, isStringArray } from "../../internal";
import type { HederaAssetTransferMethod } from "../../types";
import {
  assertSupportedHederaNetwork,
  isValidHederaAsset,
  resolveHederaAssetTransferMethod,
} from "../../utils";

/** HTS token used when converting Money strings on the resource server. */
export type HederaServerDefaultAsset = Pick<HederaDefaultAsset, "asset" | "decimals">;

/**
 * Server-side options for Hedera exact scheme.
 */
export type HederaServerConfig = {
  defaultAssets?: Record<string, HederaServerDefaultAsset>;
};

/**
 * Payment flows of `cryptoTransfer`, also served under core's `"default"` key.
 */
const CRYPTO_TRANSFER_FLOWS = {
  supported: ["authorization", "upfront"],
  default: "authorization",
} as const satisfies PaymentFlowConfig;

/**
 * Executors a `transferExecutor` quote publishes, taken from the facilitator's supported kind.
 *
 * @param network - Network being quoted
 * @param kindExtra - `extra` of the facilitator's supported kind
 * @param requested - The merchant's `extra.executors`, if any
 * @returns The executor list for the quote
 */
function quoteExecutors(
  network: Network,
  kindExtra: Record<string, unknown> | undefined,
  requested: unknown,
): string[] {
  const methods = kindExtra?.assetTransferMethods;
  const advertised = kindExtra?.executors;
  if (
    (methods !== undefined &&
      !(isStringArray(methods) && methods.includes(HEDERA_TRANSFER_EXECUTOR_METHOD))) ||
    !isStringArray(advertised) ||
    advertised.length === 0
  ) {
    throw new Error(`Facilitator does not offer transferExecutor on ${network}`);
  }
  if (requested === undefined) {
    return [...advertised];
  }
  if (!isStringArray(requested) || requested.length === 0) {
    throw new Error("transferExecutor extra.executors must be a non-empty array of executor ids");
  }
  // The merchant may narrow the facilitator's list, never widen it.
  const unadvertised = requested.find(executor => !executorListAdmits(advertised, executor));
  if (unadvertised !== undefined) {
    throw new Error(
      `Merchant executor ${unadvertised} is not advertised by the facilitator on ${network}`,
    );
  }
  return [...requested];
}

/**
 * Hedera server implementation for the Exact payment scheme.
 */
export class ExactHederaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = HEDERA_DEFAULT_ASSET_TRANSFER_METHOD;
  readonly paymentFlows = {
    // A route may still name core's sentinel explicitly; core strips it from the wire.
    [SDK_DEFAULT_ASSET_TRANSFER_METHOD]: CRYPTO_TRANSFER_FLOWS,
    cryptoTransfer: CRYPTO_TRANSFER_FLOWS,
    // `upfront` settles before the handler, and settle re-runs verification
    // (re-simulating) before it submits, so it skips no check. Offered because an
    // executor's authorization may expire within the handler's run.
    transferExecutor: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<
    HederaAssetTransferMethod | typeof SDK_DEFAULT_ASSET_TRANSFER_METHOD,
    PaymentFlowConfig
  >;
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
   * Merge facilitator-provided values into payment requirements: `feePayer` for every
   * method, and for `transferExecutor` the facilitator's `executors`, or the merchant's
   * `extra.executors` when given. Rejects a `transferExecutor` quote whose facilitator
   * kind lists `assetTransferMethods` without `transferExecutor` or advertises no
   * executor, one whose merchant list is empty or names an executor the
   * facilitator does not advertise, and one carrying any `extra.splits` other than
   * an empty array or `null`.
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
  async enhancePaymentRequirements(
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
    if (resolveHederaAssetTransferMethod(extra) === HEDERA_TRANSFER_EXECUTOR_METHOD) {
      // No facilitator advertises split support for it, so no quote may carry splits.
      if (hasSplits(extra)) {
        throw new Error("transferExecutor does not implement extra.splits");
      }
      extra.executors = quoteExecutors(
        paymentRequirements.network,
        supportedKind.extra,
        extra.executors,
      );
    }
    if (typeof supportedKind.extra?.feePayer === "string") {
      extra.feePayer = supportedKind.extra.feePayer;
    }
    return { ...paymentRequirements, extra };
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
