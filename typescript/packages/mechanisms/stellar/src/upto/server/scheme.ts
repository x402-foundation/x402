import { ExactStellarScheme } from "../../exact/server/scheme";
import { UPTO_SCHEME } from "../constants";
import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";

/**
 * Stellar resource-server side of the x402 `upto` scheme: the price is the maximum, and the
 * facilitator's settlement authority is copied into the requirements. Prices are parsed as in
 * `exact`.
 */
export class UptoStellarScheme implements SchemeNetworkServer {
  readonly scheme = UPTO_SCHEME;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;

  private readonly exact = new ExactStellarScheme();

  /**
   * Registers a money parser, tried before the default USDC conversion.
   *
   * @param parser - Converts a decimal amount, or returns null to pass
   * @returns This scheme
   */
  registerMoneyParser(parser: MoneyParser): this {
    this.exact.registerMoneyParser(parser);
    return this;
  }

  /**
   * Decimals of a default asset, for `$` settlement overrides.
   *
   * @param asset - Asset address or symbol
   * @param network - The network
   * @returns The decimals, or undefined when the asset is not a default one
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return this.exact.getAssetDecimals(asset, network);
  }

  /**
   * Parses a price (the maximum) into an asset amount.
   *
   * @param price - The price
   * @param network - The network
   * @returns The asset amount
   */
  parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    return this.exact.parsePrice(price, network);
  }

  /**
   * Copies `areFeesSponsored` and `facilitatorAddress` from the facilitator's supported kind.
   *
   * @param requirements - The base payment requirements
   * @param supportedKind - The facilitator's supported kind
   * @param supportedKind.x402Version - Protocol version
   * @param supportedKind.scheme - Scheme
   * @param supportedKind.network - Network
   * @param supportedKind.extra - `areFeesSponsored` and `facilitatorAddress`
   * @param extensionKeys - Extension keys
   * @returns The enhanced requirements
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    const enhanced = await this.exact.enhancePaymentRequirements(
      requirements,
      supportedKind,
      extensionKeys,
    );
    const facilitatorAddress = supportedKind.extra?.facilitatorAddress;
    return typeof facilitatorAddress === "string"
      ? { ...enhanced, extra: { ...enhanced.extra, facilitatorAddress } }
      : enhanced;
  }
}
