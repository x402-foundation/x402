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
import { parseMoney } from "@x402/core/utils";
import { getDefaultAsset } from "../../defaultAssets";
import type { XrplAssetTransferMethod } from "../../types";
import {
  isDecimalString,
  isIntegerString,
  isValidDestinationTag,
  isXrplAssetTransferMethod,
  requireClassicAddress,
} from "../../utils";

/**
 * XRPL server implementation for the exact payment scheme.
 */
export class ExactXrplScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod: XrplAssetTransferMethod = "sequence";
  readonly paymentFlows = {
    sequence: { supported: ["authorization"], default: "authorization" },
    ticketSequence: { supported: ["authorization"], default: "authorization" },
  } as const satisfies Record<XrplAssetTransferMethod, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom money parser
   * @returns This server scheme
   */
  registerMoneyParser(parser: MoneyParser): ExactXrplScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * XRPL IOU amounts are decimal ledger values, not atomic units.
   * `$…` settlement overrides must pass an explicit decimal amount string.
   *
   * @param _asset - Currency code or hex from payment requirements
   * @param _network - Target network
   * @returns Always undefined; IOU encoding is not atomic
   */
  getAssetDecimals(_asset: string, _network: Network): number | undefined {
    return undefined;
  }

  /**
   * Parses a price into an XRPL asset amount.
   *
   * @param price - Price to parse
   * @param network - Network identifier
   * @returns Parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset must be specified for AssetAmount on network ${network}`);
      }
      const result = {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
      this.validateAssetAmount(result);
      return result;
    }

    const { amount, symbol } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        this.validateAssetAmount(result);
        return result;
      }
    }

    const converted = this.defaultMoneyConversion(amount, network, symbol);
    this.validateAssetAmount(converted);
    return converted;
  }

  /**
   * Enhances XRPL payment requirements with fee metadata.
   *
   * Requirements are rebuilt for every request, so this method must stay
   * deterministic; invoice binding is enforced only when the resource
   * configuration provides `extra.invoiceId`.
   *
   * @param paymentRequirements - Base payment requirements
   * @param supportedKind - Facilitator-supported kind
   * @param extensionKeys - Supported facilitator extension keys
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: SupportedKind,
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void supportedKind;
    void extensionKeys;

    const assetTransferMethod = paymentRequirements.extra?.assetTransferMethod;
    if (assetTransferMethod !== undefined && !isXrplAssetTransferMethod(assetTransferMethod)) {
      throw new Error(`Unsupported assetTransferMethod: ${String(assetTransferMethod)}`);
    }
    const invoiceId = paymentRequirements.extra?.invoiceId;
    if (invoiceId !== undefined && (typeof invoiceId !== "string" || invoiceId === "")) {
      throw new Error("XRPL exact payments require a non-empty extra.invoiceId when provided");
    }
    const destinationTag = paymentRequirements.extra?.destinationTag;
    if (destinationTag !== undefined && !isValidDestinationTag(destinationTag)) {
      throw new Error(
        "XRPL exact payments require extra.destinationTag to be a 32-bit unsigned integer",
      );
    }

    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        areFeesSponsored: false,
      },
    });
  }

  /**
   * Converts a numeric dollar amount to RLUSD issued-currency units.
   *
   * @param amount - The decimal amount as a string
   * @param network - The target network
   * @param symbol - Optional ticker from a suffixed price
   * @returns Asset amount with decimal ledger value and issuer extra
   */
  private defaultMoneyConversion(amount: string, network: Network, symbol?: string): AssetAmount {
    const assetInfo = getDefaultAsset(network, symbol);
    return {
      amount,
      asset: assetInfo.asset,
      extra: { issuer: assetInfo.issuer },
    };
  }

  /**
   * Validates parsed XRPL asset amounts.
   *
   * @param assetAmount - Parsed asset amount
   */
  private validateAssetAmount(assetAmount: AssetAmount): void {
    const assetTransferMethod = assetAmount.extra?.assetTransferMethod;
    if (assetTransferMethod !== undefined && !isXrplAssetTransferMethod(assetTransferMethod)) {
      throw new Error(`Unsupported assetTransferMethod: ${String(assetTransferMethod)}`);
    }

    if (assetAmount.asset === "XRP") {
      if (!isIntegerString(assetAmount.amount)) {
        throw new Error("XRPL native payments require amount as an integer drops string");
      }
      return;
    }

    const issuer = assetAmount.extra?.issuer;
    if (typeof issuer !== "string" || issuer === "") {
      throw new Error("XRPL IOU payments require extra.issuer");
    }
    requireClassicAddress(issuer, "issuer");
    if (!isDecimalString(assetAmount.amount)) {
      throw new Error(
        "XRPL IOU payments require amount as an issued-currency decimal value string",
      );
    }
  }
}
