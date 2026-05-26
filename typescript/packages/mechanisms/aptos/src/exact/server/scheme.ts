import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { APTOS_ADDRESS_REGEX, USDC_MAINNET_FA, USDC_TESTNET_FA } from "../../constants";

/**
 * Aptos server implementation for the Exact payment scheme.
 */
export class ExactAptosScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactAptosScheme {
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
      if (!APTOS_ADDRESS_REGEX.test(price.asset)) {
        throw new Error(`Invalid asset address format: ${price.asset}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }

    const amount = this.parseMoneyToDecimal(price as Money);

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
   * @param supportedKind.extra - Extra metadata including feePayer address
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements with feePayer in extra
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

    const extra: Record<string, unknown> = { ...paymentRequirements.extra };
    if (typeof supportedKind.extra?.feePayer === "string") {
      extra.feePayer = supportedKind.extra.feePayer;
    }

    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Parse Money to a decimal number.
   *
   * @param money - The money value to parse
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
   * Default money conversion to USDC.
   *
   * @param amount - The decimal amount
   * @param network - The network to use
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const decimals = 6;
    const tokenAmount = this.convertToTokenAmount(amount.toString(), decimals);
    const asset = network === "aptos:2" ? USDC_TESTNET_FA : USDC_MAINNET_FA;
    return { amount: tokenAmount, asset, extra: {} };
  }

  /**
   * Convert a decimal amount string to a token amount string.
   *
   * @param amount - The decimal amount
   * @param decimals - Number of decimals for the token
   * @returns The amount in atomic units as a string
   */
  private convertToTokenAmount(amount: string, decimals: number): string {
    const parts = amount.split(".");
    const wholePart = parts[0] || "0";
    const fractionalPart = (parts[1] || "").padEnd(decimals, "0").slice(0, decimals);
    return BigInt(wholePart + fractionalPart).toString();
  }
}
