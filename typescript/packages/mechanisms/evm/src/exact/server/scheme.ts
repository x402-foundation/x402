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
import { findDefaultAsset, getDefaultAsset, type ExactDefaultAssetInfo } from "../../defaultAssets";
import { isUint256DecimalString, type AssetTransferMethod } from "../../types";

/**
 * Reject an amount that is not a uint256 decimal string.
 *
 * @param amount - Candidate atomic amount
 */
function requireUint256Amount(amount: string): void {
  if (isUint256DecimalString(amount)) {
    return;
  }
  throw new Error(`amount must be a uint256 decimal string, got ${JSON.stringify(amount)}`);
}

/**
 * EVM server implementation for the Exact payment scheme.
 */
export class ExactEvmScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod: AssetTransferMethod = "eip3009";
  readonly paymentFlows = {
    eip3009: { supported: ["authorization", "upfront"], default: "authorization" },
    permit2: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<AssetTransferMethod, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   * Multiple parsers can be registered - they will be tried in registration order.
   * Each parser receives a decimal string (e.g., "1.50" for $1.50).
   * If a parser returns null, the next parser in the chain will be tried.
   * The default parser is always the final fallback.
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The server instance for chaining
   *
   * @example
   * evmServer.registerMoneyParser(async (amount, network) => {
   *   // Custom conversion logic
   *   if (Number(amount) > 100) {
   *     // Use different token for large amounts
   *     return { amount: convertToTokenAmount(String(amount), 18), asset: "0xCustomToken" };
   *   }
   *   return null; // Use next parser
   * });
   */
  registerMoneyParser(parser: MoneyParser): ExactEvmScheme {
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
   * A dotted AssetAmount is returned unchanged. Any other amount must be a uint256 decimal string.
   * If price is Money (string | number), parses to decimal and tries custom parsers.
   * Falls back to default conversion if all custom parsers return null.
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
      if (!price.amount.includes(".")) {
        requireUint256Amount(price.amount);
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
        if (!result.amount.includes(".")) {
          requireUint256Amount(result.amount);
        }
        return result;
      }
    }

    const parsed = this.defaultMoneyConversion(amount, network, symbol);
    if (!parsed.amount.includes(".")) {
      requireUint256Amount(parsed.amount);
    }
    return parsed;
  }

  /**
   * Build payment requirements for this scheme/network combination
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from facilitator (unused)
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The logical payment scheme
   * @param supportedKind.network - The network identifier in CAIP-2 format
   * @param supportedKind.extra - Optional extra metadata regarding scheme/network implementation details
   * @param extensionKeys - Extension keys supported by the facilitator (unused)
   * @returns Payment requirements ready to be sent to clients
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
    void supportedKind;
    void extensionKeys;
    const rawAmount = paymentRequirements.amount;
    if (!rawAmount.includes(".")) {
      requireUint256Amount(rawAmount);
      return paymentRequirements;
    }
    const asset = findDefaultAsset(paymentRequirements.asset, paymentRequirements.network);
    if (!asset) {
      throw new Error(
        `Token ${paymentRequirements.asset} is not a registered asset for network ${paymentRequirements.network}; provide amount in atomic units`,
      );
    }
    const amount = convertToTokenAmount(rawAmount, asset.decimals);
    requireUint256Amount(amount);
    return { ...paymentRequirements, amount };
  }

  /**
   * Converts a numeric dollar amount to an AssetAmount using the default token for the network.
   *
   * @param amount - The decimal amount as a string
   * @param network - The target network
   * @param symbol - Optional ticker from a suffixed price
   * @returns The converted asset amount with token metadata
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo: ExactDefaultAssetInfo = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, assetInfo.decimals);

    // EIP-3009 tokens always need name/version for their transferWithAuthorization domain.
    // Permit2 tokens only need them if the token supports EIP-2612 (for gasless permit signing).
    // Omitting name/version for permit2 tokens signals the client to skip EIP-2612 and use
    // ERC-20 approval gas sponsoring instead.
    const includeEip712Domain = !assetInfo.assetTransferMethod || assetInfo.supportsEip2612;

    return {
      amount: tokenAmount,
      asset: assetInfo.asset,
      extra: {
        ...(includeEip712Domain && {
          name: assetInfo.name,
          version: assetInfo.version,
        }),
        ...(assetInfo.assetTransferMethod && {
          assetTransferMethod: assetInfo.assetTransferMethod,
        }),
      },
    };
  }
}
