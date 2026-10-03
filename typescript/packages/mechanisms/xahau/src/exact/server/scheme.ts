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
import type { XahauAssetTransferMethod } from "../../types";
import {
  isDecimalString,
  isIntegerString,
  isValidDestinationTag,
  isXahauAssetTransferMethod,
  requireClassicAddress,
} from "../../utils";

/**
 * Xahau server implementation for the exact payment scheme.
 */
export class ExactXahauScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod: XahauAssetTransferMethod = "sequence";
  readonly paymentFlows = {
    sequence: { supported: ["authorization", "upfront"], default: "authorization" },
    ticketSequence: { supported: ["authorization", "upfront"], default: "authorization" },
  } as const satisfies Record<XahauAssetTransferMethod, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   *
   * @param parser - Custom money parser
   * @returns This server scheme
   */
  registerMoneyParser(parser: MoneyParser): ExactXahauScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Xahau IOU amounts are decimal ledger values, not atomic units.
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
   * Parses a price into a Xahau asset amount.
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

    throw new Error(
      `No default ${symbol ?? "USD"} asset configured for ${network}; register a money parser or pass an AssetAmount`,
    );
  }

  /**
   * Enhances Xahau payment requirements with fee metadata.
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
    if (assetTransferMethod !== undefined && !isXahauAssetTransferMethod(assetTransferMethod)) {
      throw new Error(`Unsupported assetTransferMethod: ${String(assetTransferMethod)}`);
    }
    const invoiceId = paymentRequirements.extra?.invoiceId;
    if (invoiceId !== undefined && (typeof invoiceId !== "string" || invoiceId === "")) {
      throw new Error("Xahau exact payments require a non-empty extra.invoiceId when provided");
    }
    const destinationTag = paymentRequirements.extra?.destinationTag;
    if (destinationTag !== undefined && !isValidDestinationTag(destinationTag)) {
      throw new Error(
        "Xahau exact payments require extra.destinationTag to be a 32-bit unsigned integer",
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
   * Validates parsed Xahau asset amounts.
   *
   * @param assetAmount - Parsed asset amount
   */
  private validateAssetAmount(assetAmount: AssetAmount): void {
    const assetTransferMethod = assetAmount.extra?.assetTransferMethod;
    if (assetTransferMethod !== undefined && !isXahauAssetTransferMethod(assetTransferMethod)) {
      throw new Error(`Unsupported assetTransferMethod: ${String(assetTransferMethod)}`);
    }

    if (assetAmount.asset === "XAH") {
      if (!isIntegerString(assetAmount.amount)) {
        throw new Error("Xahau native payments require amount as an integer drops string");
      }
      return;
    }

    const issuer = assetAmount.extra?.issuer;
    if (typeof issuer !== "string" || issuer === "") {
      throw new Error("Xahau IOU payments require extra.issuer");
    }
    requireClassicAddress(issuer, "issuer");
    if (!isDecimalString(assetAmount.amount)) {
      throw new Error(
        "Xahau IOU payments require amount as an issued-currency decimal value string",
      );
    }
  }
}
