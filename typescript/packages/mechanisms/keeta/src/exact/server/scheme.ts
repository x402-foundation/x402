import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { validateTokenAsset } from "../../utils";

/**
 * Keeta server implementation for the Exact payment scheme.
 */
export class ExactKeetaScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

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
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Token address from payment requirements
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
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
   * Default money conversion implementation.
   * Converts decimal amount to USDC on the specified network.
   *
   * @param amount - The decimal amount (e.g., 1.50)
   * @param network - The network to use
   * @param symbol - Optional ticker from a suffixed price
   * @returns The parsed asset amount in USDC
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {},
    };
  }
}
