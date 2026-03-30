import {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { getAddress } from "viem";
import { getDefaultAsset } from "../../shared/defaultAssets";

/**
 * EVM server implementation for the Upto payment scheme.
 * Handles price parsing, payment requirements enhancement, and default asset resolution.
 */
export class UptoEvmScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Registers a custom money parser for converting prices to asset amounts.
   *
   * @param parser - The money parser function to register
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): UptoEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Returns the decimal precision of the default stablecoin for the given network.
   * Implements the optional AssetDecimalsProvider interface used by resolveSettlementOverrideAmount.
   *
   * @param _asset - The asset symbol (unused; defaults to the network's default stablecoin)
   * @param network - The network to look up the default asset for
   * @returns The number of decimal places for the asset
   */
  getAssetDecimals(_asset: string, network: Network): number {
    try {
      return getDefaultAsset(network).decimals;
    } catch {
      return 6;
    }
  }

  /**
   * Parses a price into an asset amount for the given network.
   *
   * @param price - The price to parse (string, number, or AssetAmount)
   * @param network - The target network
   * @returns Promise resolving to an asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
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
   * Enhances payment requirements with upto-specific metadata.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported scheme/network kind
   * @param supportedKind.x402Version - The x402 protocol version
   * @param supportedKind.scheme - The payment scheme name
   * @param supportedKind.network - The target network
   * @param supportedKind.extra - Optional extra metadata
   * @param extensionKeys - Extension keys to include
   * @returns Promise resolving to enhanced payment requirements
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
    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        assetTransferMethod: "permit2",
        ...(supportedKind.extra?.facilitatorAddress
          ? { facilitatorAddress: getAddress(supportedKind.extra.facilitatorAddress as string) }
          : {}),
      },
    });
  }

  /**
   * Parses a money string or number into a decimal value.
   *
   * @param money - The money value to parse
   * @returns The parsed decimal amount
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
   * Converts a numeric dollar amount to an AssetAmount using the default token for the network.
   *
   * @param amount - The dollar amount as a number
   * @param network - The target network
   * @returns The converted asset amount with token metadata
   */
  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const assetInfo = getDefaultAsset(network);
    const tokenAmount = this.convertToTokenAmount(amount.toString(), assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: {
        name: assetInfo.name,
        version: assetInfo.version,
        assetTransferMethod: "permit2",
      },
    };
  }

  /**
   * Converts a decimal string amount to an integer token amount using the given decimals.
   *
   * @param decimalAmount - The amount as a decimal string (e.g. "1.5")
   * @param decimals - The number of decimal places for the token
   * @returns The token amount as an integer string in smallest units
   */
  private convertToTokenAmount(decimalAmount: string, decimals: number): string {
    const amount = parseFloat(decimalAmount);
    if (isNaN(amount)) {
      throw new Error(`Invalid amount: ${decimalAmount}`);
    }
    const [intPart, decPart = ""] = String(amount).split(".");
    const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
    const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
    return tokenAmount;
  }
}
