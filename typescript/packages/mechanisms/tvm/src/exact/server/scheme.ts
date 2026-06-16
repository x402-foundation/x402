import {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString, parseMoneyString } from "@x402/core/utils";
import { USDT_DECIMALS, USDT_MAINNET_MINTER, USDT_TESTNET_MINTER } from "../../constants";
import { getDefaultAsset, makeZeroBitCellBoc, normalizeTonAddress } from "../../utils";

/**
 * TVM server implementation for the Exact payment scheme.
 */
export class ExactTvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser
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

    // Parse Money to decimal number
    const amount =
      typeof price === "number"
        ? price
        : parseMoneyString(price.replace(/\s*(?:USD|USDT)\s*$/i, ""));

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // Default: convert to USDT on TON
    return this.defaultMoneyConversion(amount, network);
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
      paymentRequirements.asset = getDefaultAsset(paymentRequirements.network);
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

  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    return {
      amount: convertToTokenAmount(numberToDecimalString(amount), USDT_DECIMALS),
      asset: getDefaultAsset(network),
      extra: {
        areFeesSponsored: true,
        forwardPayload: makeZeroBitCellBoc(),
        forwardTonAmount: "0",
      },
    };
  }

  getAssetDecimals(asset: string, _network: Network): number {
    if (
      normalizeTonAddress(asset) === USDT_MAINNET_MINTER ||
      normalizeTonAddress(asset) === USDT_TESTNET_MINTER
    ) {
      return USDT_DECIMALS;
    }
    throw new Error(
      `Token ${asset} is not a registered asset; provide amount in atomic units or extra.decimals`,
    );
  }
}
