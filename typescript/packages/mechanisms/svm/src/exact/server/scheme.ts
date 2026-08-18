import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { findDefaultAsset, getDefaultAsset } from "../../defaultAssets";
import { createRpcClient } from "../../utils";

/** Options for the server-side {@link ExactSvmScheme}. */
export interface ExactSvmServerOptions {
  /**
   * RPC endpoint used to fetch a recent blockhash to embed in the 402
   * challenge (`extra.recentBlockhash`). When omitted, no blockhash is embedded
   * and the client fetches its own — see {@link import('../../utils').resolveBlockhash}.
   */
  rpcUrl?: string;
}

/**
 * SVM server implementation for the Exact payment scheme.
 */
export class ExactSvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  readonly dynamicExtraFields = ["recentBlockhash", "lastValidBlockHeight"];
  private moneyParsers: MoneyParser[] = [];

  /**
   * Construct the server-side exact scheme.
   *
   * @param options - Optional server configuration (e.g. an `rpcUrl` to embed a
   *   recent blockhash in the challenge).
   */
  constructor(private readonly options: ExactSvmServerOptions = {}) {}

  /**
   * Register a custom money parser in the parser chain.
   * Multiple parsers can be registered - they will be tried in registration order.
   * Each parser receives a decimal string (e.g., "1.50" for $1.50).
   * If a parser returns null, the next parser in the chain will be tried.
   * The default parser is always the final fallback.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactSvmScheme {
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
   * Parses a price into an asset amount.
   * If price is already an AssetAmount, returns it directly.
   * If price is Money (string | number), parses to decimal and tries custom parsers.
   * Falls back to default conversion if all custom parsers return null.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns Promise that resolves to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    // If already an AssetAmount, return it directly
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

    // Try each custom money parser in order
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    // All custom parsers returned null, use default conversion
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
   * @param supportedKind.extra - Extra metadata including feePayer address
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements with feePayer in extra
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    // Mark unused parameters to satisfy linter
    void extensionKeys;

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      // The facilitator provides its address as the fee payer for transaction fees.
      feePayer: supportedKind.extra?.feePayer,
    };

    // When an RPC is configured, embed a fresh blockhash in the challenge so
    // the client can build its transaction without its own RPC round-trip and
    // against the same RPC that will settle it. The client reads it via
    // `resolveBlockhash`. Best-effort: on failure the field is omitted and the
    // client falls back to fetching its own.
    if (this.options.rpcUrl) {
      try {
        const rpc = createRpcClient(supportedKind.network, this.options.rpcUrl);
        const { value } = await rpc.getLatestBlockhash().send();
        extra.recentBlockhash = value.blockhash;
        extra.lastValidBlockHeight = value.lastValidBlockHeight.toString();
      } catch {
        // Leave the blockhash out; the client resolves one itself.
      }
    }

    return { ...paymentRequirements, extra };
  }

  /**
   * Default money conversion implementation.
   * Converts decimal amount to a supported stablecoin on the specified network.
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
