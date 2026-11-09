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
import { getAddress } from "viem";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import type { AssetTransferMethod } from "../../types";

/**
 * EVM server implementation for the Upto payment scheme.
 * Handles price parsing, payment requirements enhancement, and default asset resolution.
 */
export class UptoEvmScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  readonly defaultAssetTransferMethod: AssetTransferMethod = "permit2";
  readonly paymentFlows = {
    permit2: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<"permit2", PaymentFlowConfig>;
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
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
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

    const { amount, symbol } = parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
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
   * Converts a decimal dollar amount to an AssetAmount using the default token for the network.
   *
   * @param amount - The decimal amount as a string
   * @param network - The target network
   * @param symbol - Optional ticker from a suffixed price
   * @returns The converted asset amount with token metadata
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {
        name: assetInfo.name,
        version: assetInfo.version,
        assetTransferMethod: "permit2",
      },
    };
  }
}
