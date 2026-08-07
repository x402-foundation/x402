// Portions copyright 2026 Danny Devs (https://github.com/Danny-Devs/x402-sui), Apache-2.0

import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount } from "../../utils";
import { USDC_DECIMALS, getUsdcCoinType } from "../../constants";
import type { SuiOutput } from "../../types";

/**
 * Sui server implementation for the Exact payment scheme.
 * Handles price parsing (money chain → atomic USDC) and requirements enhancement.
 */
export class ExactSuiScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain. Parsers are tried in
   * registration order; returning null falls through to the next. The default
   * USDC conversion is always the final fallback.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The scheme instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactSuiScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse a price into an asset amount. An AssetAmount passes through; Money
   * (string | number) is parsed to a decimal, run through custom parsers, then
   * falls back to USDC conversion on the network.
   *
   * @param price - The price to parse
   * @param network - The CAIP-2 network identifier
   * @returns Promise resolving to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
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
   * Return the decimal precision of the asset for a network. USDC is 6 dp on
   * every Sui network; non-USDC assets must pass an explicit `AssetAmount` —
   * decimals are not queried on-chain.
   *
   * @param asset - The asset coin type
   * @param network - The CAIP-2 network identifier
   * @returns Number of decimal places
   */
  getAssetDecimals(asset: string, network: Network): number {
    void asset;
    void network;
    return USDC_DECIMALS;
  }

  /**
   * Build payment requirements for this scheme/network combination. Passes
   * through facilitator extras (e.g. `assetTransferMethod`) and, when
   * `extra.outputs` is declared, asserts the spec invariant `sum(outputs) == amount`.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from the facilitator's /supported
   * @param facilitatorExtensions - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    void facilitatorExtensions;

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      ...supportedKind.extra,
    };

    const outputs = extra.outputs as SuiOutput[] | undefined;
    if (Array.isArray(outputs) && outputs.length > 0) {
      const total = outputs.reduce((s, o) => s + BigInt(o.amount), 0n);
      if (total !== BigInt(paymentRequirements.amount)) {
        return Promise.reject(
          new Error(
            `invalid_payment_requirements: outputs sum ${total} ≠ amount ${paymentRequirements.amount}`,
          ),
        );
      }
    }

    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Parse Money (string | number) to a decimal number. Handles "$1.50", "1.50",
   * "1.50 USDC", 1.50, etc.
   *
   * @param money - The money value to parse
   * @returns Decimal number
   */
  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    const cleanMoney = money
      .replace(/^\$/, "")
      .replace(/\s*(USDC|USD|SUI)\s*$/i, "")
      .trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  /**
   * Default money conversion — to atomic USDC on the network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The CAIP-2 network identifier
   * @returns AssetAmount in USDC
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const tokenAmount = convertToTokenAmount(amount.toString(), USDC_DECIMALS);
    return { amount: tokenAmount, asset: getUsdcCoinType(network), extra: {} };
  }
}
