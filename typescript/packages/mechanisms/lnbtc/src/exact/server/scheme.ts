import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentFlowConfig,
  PaymentPayload,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SupportedKind,
} from "@x402/core/types";
import { decodePaymentSignatureHeader, type HTTPTransportContext } from "@x402/core/http";
import type { RequestBinding } from "../../binding";
import {
  ASSET,
  ASSET_TRANSFER_METHOD,
  DEFAULT_CLOCK_SKEW_SECONDS,
  DYNAMIC_EXTRA_FIELDS,
  Errors,
  LNBTC_NETWORKS,
  PAYMENT_FLOW,
  SCHEME,
} from "../../constants";
import type { Clock, LightningReceiver } from "../../types";
import {
  checkExpiry,
  isSupportedNetwork,
  reject,
  unixNow,
  validateInvoice,
  validateRequirements,
  validateSkew,
} from "../../validation";

/**
 * Computes the binding of the actual request from the transport context.
 * Use `httpTransportBinding` for HTTP; MCP servers supply the tool call.
 */
export type ServerRequestBinding = (
  transportContext: unknown,
) => RequestBinding | Promise<RequestBinding>;

/**
 * Options for the lnbtc resource server scheme.
 */
export interface ExactLnbtcServerOptions {
  /** Receiver node adapter with exclusive invoice-issuance authority for `payTo`. */
  receiver: LightningReceiver;
  /** Binding of the actual request, derived from server configuration. */
  requestBinding: ServerRequestBinding;
  /**
   * Called before each new invoice; return `false` to deny issuance
   * (`exact_lnbtc_invoice_issuance_denied`).
   */
  allowInvoice?: (transportContext: unknown) => boolean | Promise<boolean>;
  /** Clock-skew allowance in seconds (default 60). */
  clockSkewSeconds?: number;
  /** Clock returning Unix seconds. */
  clock?: Clock;
  /** Supported networks mapped to BOLT11 currency (default: mainnet and testnet). */
  networks?: Readonly<Record<string, string>>;
}

const SATS_PRICE = /^([0-9]+)(?:\.([0-9]+))? sats?$/;

/**
 * Resource server scheme for `exact` on `lnbtc`: binds each challenge to the
 * actual request and issues a fresh request-bound invoice.
 */
export class ExactLnbtcScheme implements SchemeNetworkServer {
  readonly scheme = SCHEME;
  readonly defaultAssetTransferMethod = ASSET_TRANSFER_METHOD;
  readonly paymentFlows: Readonly<Record<string, PaymentFlowConfig>> = {
    [ASSET_TRANSFER_METHOD]: { supported: [PAYMENT_FLOW], default: PAYMENT_FLOW },
  };
  readonly dynamicExtraFields = DYNAMIC_EXTRA_FIELDS;
  private readonly options: ExactLnbtcServerOptions;
  private readonly skew: number;
  private readonly clock: Clock;
  private readonly networks: Readonly<Record<string, string>>;
  private readonly moneyParsers: MoneyParser[] = [];
  // One binding per PaymentRequired response, shared by the hook's per-accept calls.
  private readonly bindings = new WeakMap<object, Promise<RequestBinding>>();

  /**
   * Creates the server scheme.
   *
   * @param options - Receiver adapter, request binding, and issuance policy
   */
  constructor(options: ExactLnbtcServerOptions) {
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    validateSkew(skew);
    this.options = options;
    this.skew = skew;
    this.clock = options.clock ?? unixNow;
    this.networks = options.networks ?? LNBTC_NETWORKS;
  }

  /**
   * Registers a conversion for prices other than explicit millisatoshis or
   * `"N sat(s)"`, such as dollar prices. Parsers receive the raw price.
   *
   * @param parser - Conversion returning a BTC AssetAmount in msat, or null
   * @returns This scheme, for chaining
   */
  registerMoneyParser(parser: MoneyParser): ExactLnbtcScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Converts a price to a BTC amount in millisatoshis.
   *
   * @param price - `{ asset: "BTC", amount: "<msat>" }`, `"21 sats"`, or a registered form
   * @param network - Network identifier
   * @returns The amount in millisatoshis
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isSupportedNetwork(network, this.networks)) reject(Errors.unsupportedNetwork);
    let result: AssetAmount | null = null;
    if (typeof price === "object" && price !== null) {
      result = price;
    } else if (typeof price === "string" && SATS_PRICE.test(price)) {
      result = { asset: ASSET, amount: satsToMsat(price) };
    } else {
      for (const parser of this.moneyParsers) {
        result = await parser(price, network);
        if (result) break;
      }
    }
    if (!result) {
      throw new Error(
        `Unsupported lnbtc price ${JSON.stringify(price)}: use an explicit AssetAmount ` +
          `{ asset: "BTC", amount: "<millisatoshis>" } or register a money parser`,
      );
    }
    if (result.asset !== ASSET) reject(Errors.asset);
    if (typeof result.amount !== "string" || !/^[1-9][0-9]*$/.test(result.amount)) {
      reject(Errors.amount);
    }
    return { asset: ASSET, amount: result.amount };
  }

  /**
   * Sets the transfer method and payment flow. The request binding and invoice
   * are added per request in {@link enrichPaymentRequiredResponse}.
   *
   * @param requirements - Base requirements
   * @param _supportedKind - Facilitator supported kind
   * @param _facilitatorExtensions - Facilitator extensions
   * @returns The requirements with method and flow set
   */
  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    return {
      ...requirements,
      extra: {
        ...requirements.extra,
        assetTransferMethod: ASSET_TRANSFER_METHOD,
        paymentFlow: PAYMENT_FLOW,
      },
    };
  }

  /**
   * Binds the next unbound lnbtc requirement to the actual request.
   *
   * Core calls this hook once per accept, in order, and lets each call change
   * only the accept it is processing. Every earlier lnbtc accept is bound by
   * then, so the first unbound one (no `requestHash` yet) is the current accept.
   *
   * When a payment payload accompanies the request and no error is being
   * reported, the call only prepares matching: no invoice is issued, and the
   * accepted lnbtc invoice for this network fills the dynamic `invoice` field.
   * Otherwise the requirement gets a fresh request-bound invoice.
   *
   * @param ctx - Payment-required context with the transport context
   * @returns The enriched requirements
   */
  readonly enrichPaymentRequiredResponse = async (
    ctx: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> => {
    const index = ctx.requirements.findIndex(r => this.needsBinding(r));
    if (index < 0) return ctx.requirements;

    const binding = await this.bindingFor(ctx);
    const requirements = ctx.requirements[index];
    const bound: PaymentRequirements = {
      ...requirements,
      extra: {
        ...requirements.extra,
        requestHash: binding.requestHash,
        requestBindingProfile: binding.requestBindingProfile,
        requestBindingParams: binding.requestBindingParams,
      },
    };
    const accepted = ctx.error === undefined ? paymentInContext(ctx) : undefined;
    if (accepted === undefined) {
      bound.extra.invoice = await this.issueInvoice(bound, ctx);
    } else {
      const invoice = acceptedInvoice(accepted, bound);
      if (invoice !== undefined) bound.extra.invoice = invoice;
    }
    return ctx.requirements.map((r, i) => (i === index ? bound : r));
  };

  /**
   * Whether a requirement is an lnbtc requirement that has no binding yet.
   *
   * @param requirements - Candidate requirement
   * @returns Whether to bind it
   */
  private needsBinding(requirements: PaymentRequirements): boolean {
    return (
      requirements.scheme === SCHEME &&
      isSupportedNetwork(requirements.network, this.networks) &&
      requirements.extra?.requestHash === undefined
    );
  }

  /**
   * Computes the actual request's binding once per response and checks the
   * `http:1` resource URL.
   *
   * @param ctx - Payment-required context
   * @returns The binding
   */
  private bindingFor(ctx: SchemePaymentRequiredContext): Promise<RequestBinding> {
    const key = ctx.paymentRequiredResponse ?? ctx;
    let binding = this.bindings.get(key);
    if (binding === undefined) {
      binding = (async () => {
        const computed = await this.options.requestBinding(ctx.transportContext);
        if (computed.resourceUrl !== undefined && ctx.resourceInfo?.url !== computed.resourceUrl) {
          throw new Error(
            `lnbtc http:1 requires PaymentRequired.resource.url (${ctx.resourceInfo?.url}) to ` +
              `equal the bound request URL (${computed.resourceUrl}): set the route's resource ` +
              `or publicOrigin`,
          );
        }
        return computed;
      })();
      this.bindings.set(key, binding);
    }
    return binding;
  }

  /**
   * Issues and checks a fresh invoice for bound requirements.
   *
   * @param requirements - Requirements with the request binding set
   * @param ctx - Payment-required context
   * @returns The BOLT11 invoice
   */
  private async issueInvoice(
    requirements: PaymentRequirements,
    ctx: SchemePaymentRequiredContext,
  ): Promise<string> {
    const binding = validateRequirements(requirements, this.networks);
    if (this.options.allowInvoice && !(await this.options.allowInvoice(ctx.transportContext))) {
      reject(Errors.issuanceDenied);
    }
    const invoice = await this.options.receiver.createInvoice({
      amountMsat: BigInt(requirements.amount),
      descriptionHash: binding.requestHash,
      expirySeconds: requirements.maxTimeoutSeconds,
      network: requirements.network,
    });
    const options = { now: this.clock(), skew: this.skew };
    const decoded = validateInvoice(
      invoice,
      requirements,
      binding.requestHash,
      this.networks,
      options,
    );
    checkExpiry(decoded, options, "unexpired");
    return invoice;
  }
}

/**
 * Returns the payment payload accompanying the request, if any: the core
 * context's payload, the HTTP `PAYMENT-SIGNATURE` header, or the MCP
 * `_meta["x402/payment"]` value.
 *
 * @param ctx - Payment-required context
 * @returns The payload, or undefined when the request carries none
 */
function paymentInContext(ctx: SchemePaymentRequiredContext): unknown {
  const transport = ctx.transportContext as
    | (Partial<HTTPTransportContext> & { meta?: Record<string, unknown> })
    | undefined;
  const header =
    transport?.request?.adapter?.getHeader("payment-signature") ??
    transport?.request?.paymentHeader;
  return ctx.paymentPayload ?? decodeHeader(header) ?? transport?.meta?.["x402/payment"];
}

/**
 * Returns the accepted invoice when the payload accepted lnbtc `exact` on the
 * requirement's network.
 *
 * @param payload - Untrusted payment payload
 * @param requirements - The requirement being bound
 * @returns The accepted invoice, or undefined
 */
function acceptedInvoice(payload: unknown, requirements: PaymentRequirements): string | undefined {
  const accepted = (payload as Partial<PaymentPayload> | null)?.accepted;
  const invoice = accepted?.extra?.invoice;
  return accepted?.scheme === SCHEME &&
    accepted.network === requirements.network &&
    typeof invoice === "string" &&
    invoice.length > 0
    ? invoice
    : undefined;
}

/**
 * Decodes a payment header, ignoring malformed input.
 *
 * @param header - `PAYMENT-SIGNATURE` header value
 * @returns The payload, or undefined
 */
function decodeHeader(header: string | undefined) {
  if (!header) return undefined;
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    return undefined;
  }
}

/**
 * Converts `"N sat(s)"` to millisatoshis with exact decimal arithmetic.
 *
 * @param price - Price string
 * @returns Millisatoshis as a decimal string
 */
function satsToMsat(price: string): string {
  const [, whole, fraction = ""] = SATS_PRICE.exec(price) as RegExpExecArray;
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) reject(Errors.amount);
  // Zero is refused by parsePrice's positive-integer check.
  return (BigInt(whole) * 1000n + BigInt(fraction.slice(0, 3).padEnd(3, "0"))).toString();
}
