import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { convertToTokenAmount, parseMoney } from "@x402/core/utils";
import { SCHEME_EXACT } from "../../constants";
import { isValidCasperAddress, isValidContractPackageHash } from "../../utils";
import { findDefaultAsset, getDefaultAsset, type CasperDefaultAsset } from "../../defaultAssets";

export const ErrInvalidAsset = "invalid_exact_casper_server_invalid_asset";
export const ErrInvalidPayTo = "invalid_exact_casper_server_invalid_payto";
export const ErrMissingTokenName = "invalid_exact_casper_server_missing_token_name";
export const ErrMissingTokenVersion = "invalid_exact_casper_server_missing_token_version";
export const ErrFailedToParseAmount = "invalid_exact_casper_server_failed_to_parse_amount";

/**
 * Casper server implementation for the exact payment scheme.
 */
export class ExactCasperScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME_EXACT;
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];
  private assetDecimals = new Map<string, number>();

  /**
   * Register a custom money parser.
   *
   * @param parser - Money parser.
   * @returns This scheme.
   */
  registerMoneyParser(parser: MoneyParser): ExactCasperScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset package hash.
   * @param network - Network identifier.
   * @returns Token decimals.
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Parse a price into Casper asset amount form.
   *
   * @param price - Price value.
   * @param network - Network identifier.
   * @returns Asset amount.
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!isValidContractPackageHash(price.asset)) {
        throw new Error(`${ErrInvalidAsset}: ${price.asset}`);
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
   * Validate and enrich payment requirements.
   *
   * @param paymentRequirements - Base payment requirements.
   * @param supportedKind - Facilitator supported kind.
   * @param extensionKeys - Supported extension keys.
   * @returns Enhanced payment requirements.
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    if (!isValidContractPackageHash(paymentRequirements.asset)) {
      throw new Error(`${ErrInvalidAsset}: ${paymentRequirements.asset}`);
    }
    if (!isValidCasperAddress(paymentRequirements.payTo)) {
      throw new Error(`${ErrInvalidPayTo}: ${paymentRequirements.payTo}`);
    }

    const extra = { ...paymentRequirements.extra };
    if (typeof extra.name !== "string" || extra.name === "") {
      throw new Error(ErrMissingTokenName);
    }
    if (typeof extra.version !== "string" || extra.version === "") {
      throw new Error(ErrMissingTokenVersion);
    }

    if (supportedKind.extra) {
      for (const key of extensionKeys) {
        if (Object.prototype.hasOwnProperty.call(supportedKind.extra, key)) {
          extra[key] = supportedKind.extra[key];
        }
      }
    }

    return {
      ...paymentRequirements,
      extra,
    };
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
    const defaultAsset: CasperDefaultAsset = getDefaultAsset(network, symbol);
    const tokenAmount = convertToTokenAmount(amount, defaultAsset.decimals);

    return {
      amount: tokenAmount,
      asset: defaultAsset.asset,
      extra: {
        name: defaultAsset.name,
        version: defaultAsset.version,
      },
    };
  }
}
