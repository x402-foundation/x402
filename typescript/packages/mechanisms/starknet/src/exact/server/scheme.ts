import type {
  AssetAmount,
  Money,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { ANY_CALLER } from "../../constants";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { feltEquals, isValidStarknetAddress } from "../../utils";

/**
 * Starknet server implementation for the Exact payment scheme.
 */
export class ExactStarknetScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  // The scheme has no on-wire assetTransferMethod: a payment is always a signed
  // SNIP-9 OutsideExecution, so there is nothing for a client to choose between.
  // Core strips this SDK sentinel before the 402 goes out.
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactStarknetScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined. Synchronous by interface
   * contract, so it cannot read `decimals()` onchain: only the default-asset
   * table is consulted, and core refuses a `$…` settlement override for any
   * other token rather than guessing its precision.
   *
   * @param asset - The token contract address
   * @param network - The CAIP-2 network identifier
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Refuse a facilitator whose `/supported` entry carries no usable `feePayer`.
   * Every Starknet payment is sponsored by that address, so a 402 built from
   * such an entry could never be paid; failing `initialize()` surfaces the
   * misconfiguration at startup instead of at the first client.
   *
   * @param network - The network being validated
   * @param supportedKind - The facilitator's advertised kind for this scheme/network
   * @param _ - Extensions advertised by the facilitator (unused)
   * @returns A problem message when misconfigured, or void when valid
   */
  validateFacilitatorSupport(
    network: Network,
    supportedKind: SupportedKind,
    _: string[],
  ): string | void {
    const feePayer = supportedKind.extra?.feePayer;
    if (
      typeof feePayer !== "string" ||
      !isValidStarknetAddress(feePayer) ||
      feltEquals(feePayer, ANY_CALLER)
    ) {
      return `facilitator does not advertise a valid feePayer for exact on ${network}`;
    }
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
      if (!isValidStarknetAddress(price.asset)) {
        throw new Error(`Invalid asset address format: ${price.asset}`);
      }
      return { amount: price.amount, asset: price.asset, extra: price.extra || {} };
    }

    const { amount, symbol } = parseMoney(price as Money);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, symbol);
  }

  /**
   * Build payment requirements for this scheme/network combination.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind configuration
   * @param supportedKind.x402Version - The x402 protocol version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Extra metadata including the required feePayer address
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

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      // Taken VERBATIM from the facilitator's /supported entry (spec rule 1).
      // Assigned unconditionally: `extra` is merchant-controlled, and letting a
      // locally configured value survive would let a resource server advertise a
      // feePayer its facilitator cannot settle through - an unspendable 402.
      feePayer: supportedKind.extra?.feePayer,
    };

    return Promise.resolve({ ...paymentRequirements, extra });
  }

  /**
   * Default money conversion to the network's default asset. A network with no
   * table entry has no default: the caller must supply an explicit
   * `AssetAmount`, rather than silently being priced in another network's token.
   *
   * @param amount - The decimal amount
   * @param network - The network to use
   * @param symbol - Optional ticker from a suffixed price
   * @returns The parsed asset amount in the default asset's atomic units
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);
    return { amount: tokenAmount, asset: assetInfo.asset, extra: {} };
  }
}
