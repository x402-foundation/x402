import {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { OPEN_PAYMENTS_SCHEME } from "../../constants";
import { discoverWalletAddress, getAssetScaleFromExtra } from "../../utils";
import type { OpenPaymentsServerConfig } from "../../types";

/**
 * Open Payments server implementation for the `exact` scheme on `ilp:openpayments`.
 *
 * Discovers asset code and scale from the server's wallet address and converts
 * user-friendly prices to the smallest asset unit for use in PaymentRequirements.
 */
export class ExactOpenPaymentsScheme implements SchemeNetworkServer {
  readonly scheme = OPEN_PAYMENTS_SCHEME;
  private moneyParsers: MoneyParser[] = [];
  private readonly config: OpenPaymentsServerConfig;
  private walletInfoPromise: Promise<{ assetCode: string; assetScale: number }> | null = null;

  /**
   * Creates the server scheme with the given wallet address configuration.
   *
   * @param config - Server configuration
   */
  constructor(config: OpenPaymentsServerConfig) {
    this.config = config;
  }

  /**
   * Appends a money parser. Parsers are tried in order; return null to fall through.
   *
   * @param parser - Parser to append
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactOpenPaymentsScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Converts a price to an AssetAmount using the wallet's asset code and scale.
   *
   * - Plain string/number (e.g. `"0.01"`, `"$0.01"`): human-readable decimal, converted
   *   using the wallet's discovered asset code and scale.
   * - `{ amount, asset }`: amount is a human-readable decimal; asset code is validated
   *   against the wallet (case-insensitive).
   * - `{ amount, asset, extra: { assetScale } }`: amount is an integer in the smallest unit
   *   at the given scale; asset code is validated and amount is adapted to the wallet's scale.
   *   Throws if the wallet scale is smaller than the provided scale (precision would be lost).
   *
   * Wallet discovery is required for all forms and is cached after the first call.
   *
   * @param price - AssetAmount, money string, or number
   * @param network - Passed to custom parsers
   * @returns AssetAmount in the smallest unit at the wallet's scale
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      return this.parseAssetAmount(price, network);
    }
    return this.parseMoneyString(price as string | number, network);
  }

  /**
   * Returns requirements with `payTo` set to the server's wallet address.
   *
   * @param paymentRequirements - Base requirements to enhance
   * @param supportedKind - Unused; required by the interface
   * @param supportedKind.x402Version - Protocol version
   * @param supportedKind.scheme - Scheme identifier
   * @param supportedKind.network - Network identifier
   * @param supportedKind.extra - Extra data
   * @param extensionKeys - Unused; required by the interface
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
    void supportedKind;
    void extensionKeys;
    return Promise.resolve({
      ...paymentRequirements,
      payTo: this.config.walletAddress,
    });
  }

  /**
   * Validates the asset code against the wallet, then routes to the decimal or scaled path
   * depending on whether `extra.assetScale` is present.
   *
   * @param price - AssetAmount with `amount`, `asset`, and optional `extra`
   * @param price.amount - Amount string
   * @param price.asset - Asset code to validate against the wallet
   * @param price.extra - Optional extra fields
   * @param network - Used in error messages
   * @returns AssetAmount in the smallest unit at the wallet's scale
   */
  private async parseAssetAmount(
    price: { amount: string; asset?: string; extra?: Record<string, unknown> },
    network: Network,
  ): Promise<AssetAmount> {
    if (!price.asset) {
      throw new Error(`Asset code must be specified for AssetAmount on network ${network}`);
    }

    const { assetCode: walletAssetCode, assetScale: walletAssetScale } =
      await this.fetchWalletAssetInfo();

    if (price.asset.trim().toUpperCase() !== walletAssetCode.trim().toUpperCase()) {
      throw new Error(
        `Asset code mismatch: provided "${price.asset}" but wallet uses "${walletAssetCode}"`,
      );
    }

    const inputScale = getAssetScaleFromExtra(price.extra);

    if (inputScale === undefined) {
      return this.parseDecimalAssetAmount(
        price.amount,
        price.extra,
        walletAssetCode,
        walletAssetScale,
      );
    }

    return this.parseScaledAssetAmount(
      price.amount,
      inputScale,
      price.extra,
      walletAssetCode,
      walletAssetScale,
    );
  }

  /**
   * Converts a human-readable decimal amount to the smallest unit at the wallet's scale.
   *
   * @param amount - Decimal string e.g. `"1.50"`
   * @param extra - Extra fields to carry forward alongside `assetScale`
   * @param walletAssetCode - Asset code from wallet discovery
   * @param walletAssetScale - Asset scale from wallet discovery
   * @returns AssetAmount in the smallest unit
   */
  private parseDecimalAssetAmount(
    amount: string,
    extra: Record<string, unknown> | undefined,
    walletAssetCode: string,
    walletAssetScale: number,
  ): AssetAmount {
    if (isNaN(Number(amount))) {
      throw new Error(`Invalid amount format: ${amount}`);
    }

    const smallestUnits = this.decimalToSmallestUnit(amount, walletAssetScale);
    const minimum = 1 / Math.pow(10, walletAssetScale);

    if (parseFloat(amount) > 0 && smallestUnits === 0n) {
      throw new Error(
        `Amount ${amount} is too small for asset scale ${walletAssetScale}. Minimum is ${minimum} ${walletAssetCode}.`,
      );
    }

    return {
      amount: smallestUnits.toString(),
      asset: walletAssetCode,
      extra: { ...(extra ?? {}), assetScale: walletAssetScale },
    };
  }

  /**
   * Adapts an integer amount from `inputScale` to the wallet's scale.
   * Throws if the wallet scale is smaller than `inputScale` (precision loss).
   *
   * @param amount - Integer string in smallest units at `inputScale`
   * @param inputScale - Scale the amount is expressed in
   * @param extra - Extra fields to carry forward alongside `assetScale`
   * @param walletAssetCode - Asset code from wallet discovery
   * @param walletAssetScale - Asset scale from wallet discovery
   * @returns AssetAmount adapted to the wallet's scale
   */
  private parseScaledAssetAmount(
    amount: string,
    inputScale: number,
    extra: Record<string, unknown> | undefined,
    walletAssetCode: string,
    walletAssetScale: number,
  ): AssetAmount {
    if (walletAssetScale < inputScale) {
      throw new Error(
        `Cannot adapt amount from scale ${inputScale} to wallet scale ${walletAssetScale}: would lose precision`,
      );
    }

    let inputAmount: bigint;
    try {
      inputAmount = BigInt(amount);
    } catch {
      throw new Error(
        `Amount "${amount}" is not a valid integer. When assetScale is provided, amount must be an integer string representing the smallest unit at that scale.`,
      );
    }

    const scaleDiff = walletAssetScale - inputScale;
    const adaptedAmount = inputAmount * 10n ** BigInt(scaleDiff);
    return {
      amount: adaptedAmount.toString(),
      asset: walletAssetCode,
      extra: { ...(extra ?? {}), assetScale: walletAssetScale },
    };
  }

  /**
   * Converts a plain money string or number to an AssetAmount.
   * Tries registered custom parsers in order; falls back to wallet-based conversion.
   *
   * @param price - Money string (e.g. `"$0.01"`) or number (e.g. `0.01`)
   * @param network - Passed to custom parsers
   * @returns AssetAmount in the smallest unit
   */
  private async parseMoneyString(price: string | number, network: Network): Promise<AssetAmount> {
    const decimal = this.moneyToDecimalString(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(parseFloat(decimal), network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(decimal);
  }

  /**
   * Normalizes a money string or number to a plain decimal string, stripping a leading `$`.
   * Numbers in scientific notation (e.g. `1e-8`) are expanded to full decimal form.
   *
   * @param money - e.g. `"0.01"`, `"$0.01"`, or `0.01`
   * @returns Normalized decimal string e.g. `"0.01"`
   */
  private moneyToDecimalString(money: string | number): string {
    if (typeof money === "number") {
      if (!Number.isFinite(money)) {
        throw new Error(`Invalid money format: ${money}`);
      }
      const str = String(money);
      // String() uses scientific notation for very small/large numbers (e.g. 1e-8); expand it.
      if (str.includes("e") || str.includes("E")) {
        return money.toFixed(20).replace(/\.?0+$/, "");
      }
      return str;
    }

    const normalized = money.replace(/^\$/, "").trim();
    if (isNaN(Number(normalized))) {
      throw new Error(`Invalid money format: ${money}`);
    }
    return normalized;
  }

  /**
   * Converts a non-negative decimal string to the smallest unit as a BigInt,
   * using string arithmetic to avoid floating-point precision loss.
   * Fractional digits beyond `scale` are truncated (floor semantics).
   *
   * @param decimal - Decimal string e.g. `"0.07"`, `"1.5"`, `"100"`
   * @param scale - Asset scale (decimal places in the smallest unit)
   * @returns Integer value in smallest units
   */
  private decimalToSmallestUnit(decimal: string, scale: number): bigint {
    const [intPart, fracPart = ""] = decimal.split(".");
    const paddedFrac = fracPart.slice(0, scale).padEnd(scale, "0");
    return BigInt((intPart || "0") + paddedFrac);
  }

  /**
   * Lazily fetches and caches wallet asset info (assetCode + assetScale).
   * Resets the cache on failure so the next call will retry.
   *
   * @returns Promise resolving to wallet asset info
   * @throws Error if discovery fails or the wallet response is missing required fields
   */
  private fetchWalletAssetInfo(): Promise<{ assetCode: string; assetScale: number }> {
    if (!this.walletInfoPromise) {
      this.walletInfoPromise = discoverWalletAddress(this.config.walletAddress)
        .then(info => {
          if (!info.assetCode || info.assetScale === undefined) {
            throw new Error(
              `Wallet address ${this.config.walletAddress} did not return assetCode or assetScale`,
            );
          }
          return { assetCode: info.assetCode, assetScale: info.assetScale };
        })
        .catch(err => {
          this.walletInfoPromise = null; // Allow retry on next call
          throw err;
        });
    }
    return this.walletInfoPromise;
  }

  /**
   * Converts a decimal string to the smallest asset unit using the wallet's scale.
   * Throws if wallet discovery fails or the amount rounds to zero.
   *
   * @param decimal - Decimal string to convert (e.g. `"0.01"`)
   * @returns AssetAmount in the smallest unit
   */
  private async defaultMoneyConversion(decimal: string): Promise<AssetAmount> {
    const { assetCode, assetScale } = await this.fetchWalletAssetInfo();
    const smallestUnits = this.decimalToSmallestUnit(decimal, assetScale);
    const minimum = 1 / Math.pow(10, assetScale);

    if (parseFloat(decimal) > 0 && smallestUnits === 0n) {
      throw new Error(
        `Amount ${decimal} is too small for asset scale ${assetScale}. Minimum is ${minimum} ${assetCode}.`,
      );
    }

    return {
      amount: smallestUnits.toString(),
      asset: assetCode,
      extra: { assetScale },
    };
  }
}
