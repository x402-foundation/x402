import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, numberToDecimalString, parseMoneyString } from "@x402/core/utils";
import { getUsdcAddress, validateTokenAsset } from "../../utils";

/**
 * Keeta server implementation for the Exact payment scheme.
 */
export class ExactKeetaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];
  private usdcAddressCache: Map<Network, string> = new Map();

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactKeetaScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parses a price into an asset amount.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns Promise that resolves to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }

      if (!validateTokenAsset(price.asset)) {
        throw new Error(`Invalid asset address: ${price.asset}`);
      }

      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }

    const amount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind configuration
   * @param supportedKind.x402Version - The x402 protocol version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Extra metadata
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements
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
    void supportedKind;

    // TODO: Add `external` field once we have support for it such
    //       as an integration of asset movement anchors.
    return Promise.resolve(paymentRequirements);
  }

  /**
   * Parse Money (string | number) to a decimal number.
   * Handles formats like "$1.50", "1.50", 1.50, etc.
   *
   * @param money - The money value to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    let decimalString = typeof money === "number" ? numberToDecimalString(money) : money;
    return parseMoneyString(decimalString);
  }

  /**
   * Default money conversion implementation.
   * Converts decimal amount to USDC on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @returns The parsed asset amount in USDC
   */
  private async defaultMoneyConversion(amount: number, network: Network): Promise<AssetAmount> {
    // Convert decimal amount to token amount (USDC has 6 decimals)
    const tokenAmount = convertToTokenAmount(amount.toString(), 6);

    // Cache USDC address for the server's lifetime since it's not
    // really expected to change. If it changes, the server must be restarted.
    let usdcAddress = this.usdcAddressCache.get(network);
    if (!usdcAddress) {
      usdcAddress = await getUsdcAddress(network);
      this.usdcAddressCache.set(network, usdcAddress);
    }

    return {
      amount: tokenAmount,
      asset: usdcAddress,
      extra: {},
    };
  }
}
