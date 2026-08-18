import {
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
import { makeZeroBitCellBoc, normalizeTonAddress } from "../../utils";

/**
 * TVM server implementation for the Exact payment scheme.
 */
export class ExactTvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The scheme instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactTvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, return it directly
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: normalizeTonAddress(price.asset),
        extra: price.extra || {},
      };
    }

    const { amount, symbol } = parseMoney(price);

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // Default: convert to USDT on TON
    return this.defaultMoneyConversion(amount, network, symbol);
  }

  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    _supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;
    const extra = {
      ...(paymentRequirements.extra ?? {}),
    } as Record<string, unknown>;

    if (!paymentRequirements.asset) {
      paymentRequirements.asset = getDefaultAsset(paymentRequirements.network).asset;
    }
    paymentRequirements.asset = normalizeTonAddress(paymentRequirements.asset);
    paymentRequirements.payTo = normalizeTonAddress(paymentRequirements.payTo);

    if (paymentRequirements.amount.includes(".")) {
      const decimals =
        typeof extra.decimals === "number" || typeof extra.decimals === "string"
          ? Number(extra.decimals)
          : this.getAssetDecimals(paymentRequirements.asset, paymentRequirements.network);
      paymentRequirements.amount = convertToTokenAmount(paymentRequirements.amount, decimals);
    }

    if (typeof extra.responseDestination === "string") {
      extra.responseDestination = normalizeTonAddress(extra.responseDestination);
    }
    if (!("areFeesSponsored" in extra)) {
      extra.areFeesSponsored = _supportedKind.extra?.areFeesSponsored ?? true;
    }
    if (!("forwardPayload" in extra)) {
      extra.forwardPayload = makeZeroBitCellBoc();
    }
    if (!("forwardTonAmount" in extra)) {
      extra.forwardTonAmount = "0";
    }
    paymentRequirements.extra = extra;

    return Promise.resolve(paymentRequirements);
  }

  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    return {
      amount: convertToTokenAmount(amount, assetInfo.decimals),
      asset: assetInfo.asset,
      extra: {
        areFeesSponsored: true,
        forwardPayload: makeZeroBitCellBoc(),
        forwardTonAmount: "0",
      },
    };
  }

  getAssetDecimals(asset: string, network: Network): number {
    const decimals = findDefaultAsset(asset, network)?.decimals;
    if (decimals === undefined) {
      throw new Error(
        `Token ${asset} is not a registered asset; provide amount in atomic units or extra.decimals`,
      );
    }
    return decimals;
  }
}
