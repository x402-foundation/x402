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
import {
  convertToTokenAmount,
  parseMoney,
} from "@x402/core/utils";
import { SCHEME_EXACT } from "../../constants";
import { isValidCasperAddress, isValidContractPackageHash } from "../../utils";
import { findDefaultAsset } from "../../defaultAssets";

export const ErrNoDefaultAsset = "invalid_exact_casper_server_no_default_asset";
export const ErrInvalidAsset = "invalid_exact_casper_server_invalid_asset";
export const ErrInvalidPayTo = "invalid_exact_casper_server_invalid_payto";
export const ErrMissingTokenName = "invalid_exact_casper_server_missing_token_name";
export const ErrMissingTokenVersion = "invalid_exact_casper_server_missing_token_version";
export const ErrFailedToParseAmount = "invalid_exact_casper_server_failed_to_parse_amount";

/**
 * Build a decimals registry key.
 *
 * @param network - Network identifier.
 * @param asset - Asset package hash.
 * @returns Registry key.
 */
function assetDecimalsKey(network: Network, asset: string): string {
  return `${network}:${asset}`;
}

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

    throw new Error(`${ErrNoDefaultAsset}: no default asset configured for network ${network}`);
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
}
