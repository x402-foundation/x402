import { x402Version } from "..";
import { DefaultAsset, SchemeNetworkClient } from "../types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../types/payments";
import {
  Money,
  Network,
  PaymentRequired,
  PaymentRequirementsV1,
  SettleResponse,
} from "../types";
import {
  ADDITIVE_ARRAY_INFO_FIELDS,
  convertToTokenAmount,
  deepEqual,
  findByNetworkAndScheme,
  findSchemesByNetwork,
  networkMatchesPattern,
  parseMoney,
  toComparableArray,
} from "../utils";

/**
 * Client Hook Context Interfaces
 */

export interface PaymentCreationContext {
  paymentRequired: PaymentRequired;
  selectedRequirements: PaymentRequirements;
}

export interface PaymentCreatedContext extends PaymentCreationContext {
  paymentPayload: PaymentPayload;
}

export interface PaymentCreationFailureContext extends PaymentCreationContext {
  error: Error;
}

/**
 * Client Hook Type Definitions
 */

export type BeforePaymentCreationHook = (
  context: PaymentCreationContext,
) => Promise<void | { abort: true; reason: string }>;

export type AfterPaymentCreationHook = (context: PaymentCreatedContext) => Promise<void>;

export type OnPaymentCreationFailureHook = (
  context: PaymentCreationFailureContext,
) => Promise<void | { recovered: true; payload: PaymentPayload }>;

/**
 * Context provided to payment response hooks after the paid request completes.
 *
 * Discriminate by what's present:
 * - `settleResponse` with `success: true` → settle succeeded
 * - `settleResponse` with `success: false` → settle failed
 * - `paymentRequired` (no `settleResponse`) → verify failed
 * - `error` → transport or parse error
 */
export interface PaymentResponseContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  settleResponse?: SettleResponse;
  paymentRequired?: PaymentRequired;
  error?: Error;
}

/**
 * Hook fired after a paid request completes.
 * Return `{ recovered: true }` to signal the transport should retry with a fresh payload.
 */
export type OnPaymentResponseHook = (
  ctx: PaymentResponseContext,
) => Promise<void | { recovered: true }>;

export type SelectPaymentRequirements = (x402Version: number, paymentRequirements: PaymentRequirements[]) => PaymentRequirements;

type ClientHookAdapterHandles = {
  beforePaymentCreation?: BeforePaymentCreationHook;
  afterPaymentCreation?: AfterPaymentCreationHook;
  onPaymentCreationFailure?: OnPaymentCreationFailureHook;
  onPaymentResponse?: OnPaymentResponseHook;
};

type ClientHookPhase = keyof ClientHookAdapterHandles;

export interface ClientExtensionHooks {
  onBeforePaymentCreation?: (
    declaration: unknown,
    context: PaymentCreationContext,
  ) => Promise<void | { abort: true; reason: string }>;
  onAfterPaymentCreation?: (
    declaration: unknown,
    context: PaymentCreatedContext,
  ) => Promise<void>;
  onPaymentCreationFailure?: (
    declaration: unknown,
    context: PaymentCreationFailureContext,
  ) => Promise<void | { recovered: true; payload: PaymentPayload }>;
  onPaymentResponse?: (
    declaration: unknown,
    context: PaymentResponseContext,
  ) => Promise<void | { recovered: true }>;
}

export interface ClientTransportExtensionHooks {
  [transport: string]: unknown;
}

/**
 * Extension that can enrich payment payloads on the client side.
 *
 * Client extensions are invoked after the scheme creates the base payment payload
 * but before it is returned. This allows mechanism-specific logic (e.g., EVM EIP-2612
 * permit signing) to enrich the payload's extensions data.
 */
export interface ClientExtension {
  /**
   * Unique key identifying this extension (e.g., "eip2612GasSponsoring").
   * Must match the extension key used in PaymentRequired.extensions.
   */
  key: string;

  /**
   * Called after payload creation for every registered extension. Allows the
   * extension to enrich the payload with extension-specific data. Extensions
   * that require a server declaration must no-op internally when the server
   * did not advertise them in paymentRequired.extensions.
   *
   * @param paymentPayload - The payment payload to enrich
   * @param paymentRequired - The original PaymentRequired response
   * @returns The enriched payment payload
   */
  enrichPaymentPayload?: (
    paymentPayload: PaymentPayload,
    paymentRequired: PaymentRequired,
  ) => Promise<PaymentPayload>;

  hooks?: ClientExtensionHooks;
  transportHooks?: ClientTransportExtensionHooks;
}

/**
 * A policy function that filters or transforms payment requirements.
 * Policies are applied in order before the selector chooses the final option.
 *
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - Array of payment requirements to filter/transform
 * @returns Filtered array of payment requirements
 */
export type PaymentPolicy = (x402Version: number, paymentRequirements: PaymentRequirements[]) => PaymentRequirements[];

/** Default USD cap for recognized default assets. Override via {@link SpendControls}. */
export const DEFAULT_MAX_AMOUNT_PER_PAYMENT: Money = "$1";

/**
 * Opt-in asset for {@link SpendControls.allowedAssets}.
 * Default assets are always allowed; list non-default tokens here (and optional atomic caps).
 */
export interface SpendControlAsset {
  network: Network;
  /** On-chain asset id, or a default-asset symbol (e.g. `"PYUSD"`). */
  asset: string;
  /** Optional integer atomic per-payment cap (e.g. `"2000000"`), not `"$1"`. Omit to allow uncapped. */
  maxAmountPerPayment?: string;
}

/**
 * Client spend controls (enforced before policies).
 * Network scoping is scheme registration, not a control here.
 *
 * By default only assets `findDefaultAsset` recognizes are allowed, capped at
 * {@link DEFAULT_MAX_AMOUNT_PER_PAYMENT}. Pass `spendControls: false` to disable
 * all spend controls (any asset, no caps).
 */
export interface SpendControls {
  /**
   * Per-payment USD cap on assets `findDefaultAsset` recognizes.
   * `false` disables. Override per asset with `allowedAssets[].maxAmountPerPayment`.
   *
   * @default "$1"
   */
  maxAmountPerPayment?: Money | false;
  /**
   * Opt-in non-default assets.
   * - omit: default assets only
   * - `true`: allow any asset (USD cap still applies to defaults)
   * - list: defaults plus listed entries; optional integer atomic `maxAmountPerPayment` per entry
   */
  allowedAssets?: true | SpendControlAsset[];
  /**
   * Caller's expected price, enforced pre-signature. When set, any offered
   * requirement whose amount differs from the expectation (beyond
   * {@link SpendControls.expectedAmountTolerance}) is rejected before signing.
   *
   * - Money value (e.g. `"$0.01"`): every offer must match it. Converted to
   *   atomic units via the requirement's default-asset decimals, like the USD cap.
   * - `"first-accepted"`: the first requirement this client successfully creates
   *   a payload for anchors the expectation per quote key (resource url + scheme
   *   + network + asset + payTo); later offers for the same key must match the
   *   anchored amount. Anchoring happens at payload creation — the client-side
   *   commitment point — since the client never observes settlement.
   * - `false` / unset: no expectation check (default, fully backward compatible).
   */
  expectedAmount?: Money | "first-accepted" | false;
  /**
   * Repricing tolerance as a multiplier on the expectation. `1.0` = exact match
   * (both directions: an offer above `expected * tolerance` or below
   * `expected / tolerance` is rejected). Only meaningful when `expectedAmount`
   * is set. Must be >= 1.0.
   *
   * @default 1.0
   */
  expectedAmountTolerance?: number;
  /**
   * Caller's expected recipient, enforced pre-signature whenever set (both
   * expectedAmount modes and standalone). Establishes that the recipient was
   * caller-approved — complementing the recipient ledger, which only detects
   * substitution against the first committed payTo. A mismatch is rejected
   * with {@link QuoteMismatchError} (`field: "payTo"`, `source: "caller-config"`).
   */
  expectedPayTo?: string;
}

/**
 * Origin of a quote expectation: configured explicitly by the caller, or
 * anchored by the quote ledger after a first accepted offer.
 */
export type QuoteExpectationSource = "caller-config" | "quote-ledger";

/**
 * Thrown when an offered amount does not match the caller-anchored price
 * expectation (see {@link SpendControls.expectedAmount}). Fail-closed: the
 * payment is rejected before payload creation, never silently signed.
 */
export class QuoteMismatchError extends Error {
  /** Quote key tuple (resource url, scheme, network, asset, payTo). */
  readonly quoteKey: string;
  /** Expected value, integer atomic string (amount) or address (payTo). */
  readonly expected: string;
  /** Offered value, integer atomic string (amount) or address (payTo). */
  readonly offered: string;
  /** Where the expectation came from. */
  readonly source: QuoteExpectationSource;
  /** Which quote field mismatched. */
  readonly field: "amount" | "payTo";

  /**
   * Creates a QuoteMismatchError.
   *
   * @param args - Rejection details
   * @param args.quoteKey - Quote key tuple (resource url, scheme, network, asset, payTo)
   * @param args.expected - Expected value, integer atomic string (amount) or address (payTo)
   * @param args.offered - Offered value, integer atomic string (amount) or address (payTo)
   * @param args.source - Where the expectation came from
   * @param args.field - Which quote field mismatched (default "amount")
   */
  constructor(args: {
    quoteKey: string;
    expected: string;
    offered: string;
    source: QuoteExpectationSource;
    field?: "amount" | "payTo";
  }) {
    super(
      args.field === "payTo"
        ? `quote-check-rejected: quote_recipient_mismatch: payTo ${args.expected} -> ${args.offered} ` +
            `on a known quote. The server-declared recipient does not match the recipient bound at the ` +
            `client's first commitment for this resource. Paying a new recipient requires a fresh client ` +
            `(or spendControls: false) — recipient substitution otherwise stays rejected.`
        : `quote-check-rejected: quote_mismatch_vs_${args.source === "quote-ledger" ? "accepted" : "expected"}: ` +
            `amount ${args.expected} -> ${args.offered}. The server-declared amount does not match the ` +
            `caller-anchored price expectation. Adjust spendControls.expectedAmount, raise ` +
            `expectedAmountTolerance for legitimate repricing, or set expectedAmount: false to disable.`,
    );
    this.name = "QuoteMismatchError";
    this.quoteKey = args.quoteKey;
    this.expected = args.expected;
    this.offered = args.offered;
    this.source = args.source;
    this.field = args.field ?? "amount";
  }
}

/**
 * Thrown when an expectation control is enabled but an offer cannot be
 * evaluated against it at all (non-atomic decimal-ledger amount, or an
 * explicit Money expectation against an asset with unknown decimals).
 * Fail-closed: silently skipping the check would sign an unchecked payment.
 */
export class QuoteExpectationUnsupportedError extends Error {
  /** Quote key tuple (resource url, scheme, network, asset, payTo). */
  readonly quoteKey: string;
  /** Why the expectation cannot be evaluated. */
  readonly reason: "non-atomic-amount" | "unknown-asset-decimals";

  /**
   * Creates a QuoteExpectationUnsupportedError.
   *
   * @param args - Rejection details
   * @param args.quoteKey - Quote key tuple
   * @param args.reason - Why the expectation cannot be evaluated
   */
  constructor(args: {
    quoteKey: string;
    reason: "non-atomic-amount" | "unknown-asset-decimals";
  }) {
    super(
      `quote-check-unsupported: ${args.reason}. The offered requirement cannot be evaluated ` +
        `against spendControls.expectedAmount (${args.reason === "non-atomic-amount" ? "the amount is not an integer atomic string, e.g. a decimal-ledger asset" : "the asset has no known default-asset decimals for Money conversion"}). ` +
        `Rejected fail-closed: an asset allowlist entry or a higher spend cap is not a ` +
        `substitute for an unchecked expectation. Set expectedAmount: false to disable.`,
    );
    this.name = "QuoteExpectationUnsupportedError";
    this.quoteKey = args.quoteKey;
    this.reason = args.reason;
  }
}

/**
 * Returns whether `amount` is an integer atomic string.
 *
 * @param amount - Amount to test
 * @returns True when the value is all digits
 */
function isAtomicAmount(amount: string): boolean {
  return /^\d+$/.test(amount);
}

/**
 * Canonical recipient representation for comparisons and quote-ledger keys.
 * EVM hex addresses compare case-insensitively (checksummed and lowercase
 * forms name the same account). Case-sensitive formats (e.g. base58) are
 * untouched.
 *
 * @param recipient - Recipient address to canonicalize
 * @returns Canonical recipient representation
 */
function canonicalRecipient(recipient: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(recipient) ? recipient.toLowerCase() : recipient;
}

/**
 * Compare two recipients using their canonical representations.
 *
 * @param a - First recipient address
 * @param b - Second recipient address
 * @returns True when both addresses name the same recipient
 */
function sameRecipient(a: string, b: string): boolean {
  return canonicalRecipient(a) === canonicalRecipient(b);
}

/**
 * Finds the matching `allowedAssets` entry for a requirement.
 *
 * @param controls - Active spend controls
 * @param requirement - Payment requirement
 * @param defaultAsset - Default-asset lookup result
 * @returns Matching entry, if any
 */
function findSpendControlAssetEntry(
  controls: SpendControls,
  requirement: PaymentRequirements,
  defaultAsset: DefaultAsset | undefined,
): SpendControlAsset | undefined {
  if (controls.allowedAssets === true) {
    return undefined;
  }
  return controls.allowedAssets?.find(entry => {
    if (!networkMatchesPattern(entry.network, requirement.network)) {
      return false;
    }
    if (entry.asset.toLowerCase() === requirement.asset.toLowerCase()) {
      return true;
    }
    return (
      defaultAsset != null && defaultAsset.symbol.toLowerCase() === entry.asset.toLowerCase()
    );
  });
}

/**
 * Resolves the atomic spend cap for filtering and payload context.
 *
 * @param controls - Client spend controls
 * @param requirement - Payment requirement
 * @param defaultAsset - Default-asset lookup result
 * @returns Atomic cap, or undefined when uncapped
 */
function resolveAtomicSpendCap(
  controls: SpendControls | false,
  requirement: PaymentRequirements,
  defaultAsset: DefaultAsset | undefined,
): string | undefined {
  if (controls === false) {
    return undefined;
  }

  const assetEntry = findSpendControlAssetEntry(controls, requirement, defaultAsset);
  if (assetEntry?.maxAmountPerPayment != null) {
    if (!isAtomicAmount(assetEntry.maxAmountPerPayment)) {
      throw new Error(
        `spendControls.allowedAssets[].maxAmountPerPayment must be an integer atomic amount, not a dollar value; got ${JSON.stringify(assetEntry.maxAmountPerPayment)}`,
      );
    }
    return assetEntry.maxAmountPerPayment;
  }

  if (!defaultAsset || controls.maxAmountPerPayment === false) {
    return undefined;
  }

  const usdLimit = controls.maxAmountPerPayment ?? DEFAULT_MAX_AMOUNT_PER_PAYMENT;
  return convertToTokenAmount(parseMoney(usdLimit).amount, defaultAsset.decimals);
}

/**
 * Configuration for registering a payment scheme with a specific network
 */
export interface SchemeRegistration {
  /**
   * The network identifier (e.g., 'eip155:8453', 'solana:mainnet')
   */
  network: Network;

  /**
   * The scheme client implementation for this network
   */
  client: SchemeNetworkClient;

  /**
   * The x402 protocol version to use for this scheme
   *
   * @default 2
   */
  x402Version?: number;
}

/**
 * Configuration options for the fetch wrapper
 */
export interface x402ClientConfig {
  /**
   * Array of scheme registrations defining which payment methods are supported
   */
  schemes: SchemeRegistration[];

  /**
   * Policies to apply to the client
   */
  policies?: PaymentPolicy[];

  /**
   * Spend controls; default is default assets only + {@link DEFAULT_MAX_AMOUNT_PER_PAYMENT}.
   * Pass `false` to disable all spend controls (any asset, no caps).
   */
  spendControls?: SpendControls | false;

  /**
   * Custom payment requirements selector function
   * If not provided, uses the default selector (first available option)
   */
  paymentRequirementsSelector?: SelectPaymentRequirements;
}

/**
 * Core client for managing x402 payment schemes and creating payment payloads.
 *
 * Handles registration of payment schemes, policy-based filtering of payment requirements,
 * and creation of payment payloads based on server requirements.
 */
export class x402Client {
  private readonly paymentRequirementsSelector: SelectPaymentRequirements;
  private readonly registeredClientSchemes: Map<number, Map<string, Map<string, SchemeNetworkClient>>> = new Map();
  private readonly schemeClientHookAdapters: Map<number, Map<string, Map<string, ClientHookAdapterHandles>>> = new Map();
  private readonly policies: PaymentPolicy[] = [];
  private readonly registeredExtensions: Map<string, ClientExtension> = new Map();
  private spendControls: SpendControls | false = {};
  private readonly quoteLedger: Map<string, { atomic: string; anchoredAt: number }> = new Map();
  /**
   * Recipient binding: first payTo per (resource url, scheme, network, asset)
   * tuple, recorded at the client's commitment point. Enforced in both
   * expectedAmount modes — a substituted recipient on a known quote is
   * rejected pre-signature (the A5 flank from #3866).
   */
  private readonly recipientLedger: Map<string, string> = new Map();
  /** Serialization chain for createPaymentPayload (anchor check+record atomicity). */
  private payloadChain: Promise<unknown> = Promise.resolve();

  private beforePaymentCreationHooks: BeforePaymentCreationHook[] = [];
  private afterPaymentCreationHooks: AfterPaymentCreationHook[] = [];
  private onPaymentCreationFailureHooks: OnPaymentCreationFailureHook[] = [];
  private paymentResponseHooks: OnPaymentResponseHook[] = [];

  /**
   * Creates a new x402Client instance.
   *
   * @param paymentRequirementsSelector - Function to select payment requirements from available options
   */
  constructor(paymentRequirementsSelector?: SelectPaymentRequirements) {
    this.paymentRequirementsSelector = paymentRequirementsSelector || ((x402Version, accepts) => accepts[0]);
  }

  /**
   * Creates a new x402Client instance from a configuration object.
   *
   * @param config - The client configuration including schemes, policies, and payment requirements selector
   * @returns A configured x402Client instance
   */
  static fromConfig(config: x402ClientConfig): x402Client {
    const client = new x402Client(config.paymentRequirementsSelector);
    config.schemes.forEach(scheme => {
      if (scheme.x402Version === 1) {
        client.registerV1(scheme.network, scheme.client);
      } else {
        client.register(scheme.network, scheme.client);
      }
    });
    config.policies?.forEach(policy => {
      client.registerPolicy(policy);
    });
    if (config.spendControls !== undefined) {
      client.setSpendControls(config.spendControls);
    }
    return client;
  }

  /**
   * Registers a scheme client for the current x402 version.
   *
   * @param network - The network to register the client for
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  register(network: Network, client: SchemeNetworkClient): x402Client {
    return this._registerScheme(x402Version, network, client);
  }

  /**
   * Registers a scheme client for x402 version 1.
   *
   * @param network - The v1 network identifier (e.g., 'base-sepolia', 'solana-devnet')
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  registerV1(network: string, client: SchemeNetworkClient): x402Client {
    return this._registerScheme(1, network as Network, client);
  }

  /**
   * Registers a policy to filter or transform payment requirements.
   *
   * Policies are applied in order after filtering by registered schemes
   * and before the selector chooses the final payment requirement.
   *
   * @param policy - Function to filter/transform payment requirements
   * @returns The x402Client instance for chaining
   *
   * @example
   * ```typescript
   * // Prefer cheaper options
   * client.registerPolicy((version, reqs) =>
   *   reqs.filter(r => BigInt(r.value) < BigInt('1000000'))
   * );
   *
   * // Prefer specific networks
   * client.registerPolicy((version, reqs) =>
   *   reqs.filter(r => r.network.startsWith('eip155:'))
   * );
   * ```
   */
  registerPolicy(policy: PaymentPolicy): x402Client {
    this.policies.push(policy);
    return this;
  }

  /**
   * Replace spend controls. Pass `false` to disable all spend controls.
   * When an object is passed, omitted `maxAmountPerPayment` still defaults to
   * {@link DEFAULT_MAX_AMOUNT_PER_PAYMENT}.
   *
   * @param controls - Spend control configuration, or `false` to disable
   * @returns This client for chaining
   */
  setSpendControls(controls: SpendControls | false): x402Client {
    this.spendControls = controls;
    return this;
  }

  /**
   * Registers a client extension that can enrich payment payloads.
   *
   * Extensions are invoked after the scheme creates the base payload and the
   * payload is wrapped with extensions/resource/accepted data. Every registered
   * extension's `enrichPaymentPayload` hook is called to modify the payload.
   * Server-declared fields are preserved via merge after enrichment.
   *
   * @param extension - The client extension to register
   * @returns The x402Client instance for chaining
   */
  registerExtension(extension: ClientExtension): x402Client {
    this.registeredExtensions.set(extension.key, extension);
    return this;
  }

  /**
   * Get all registered client extensions.
   *
   * @returns Array of registered extensions
   */
  getExtensions(): ClientExtension[] {
    return Array.from(this.registeredExtensions.values());
  }

  /**
   * Register a hook to execute before payment payload creation.
   * Can abort creation by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onBeforePaymentCreation(hook: BeforePaymentCreationHook): x402Client {
    this.beforePaymentCreationHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after successful payment payload creation.
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onAfterPaymentCreation(hook: AfterPaymentCreationHook): x402Client {
    this.afterPaymentCreationHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when payment payload creation fails.
   * Can recover from failure by returning { recovered: true, payload: PaymentPayload }
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onPaymentCreationFailure(hook: OnPaymentCreationFailureHook): x402Client {
    this.onPaymentCreationFailureHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after a paid request completes.
   * Can signal recovery by returning { recovered: true }, causing the transport to retry.
   *
   * @param hook - The hook function to register
   * @returns The x402Client instance for chaining
   */
  onPaymentResponse(hook: OnPaymentResponseHook): x402Client {
    this.paymentResponseHooks.push(hook);
    return this;
  }

  /**
   * Fires all registered payment response hooks in order.
   * Returns `{ recovered: true }` if any hook signals recovery (first wins).
   *
   * @param ctx - The payment response context
   * @returns Recovery signal or undefined
   */
  async handlePaymentResponse(
    ctx: PaymentResponseContext,
  ): Promise<{ recovered: true } | undefined> {
    for (const hook of this.getLabeledHooks(
      "onPaymentResponse",
      ctx.paymentPayload.x402Version,
      ctx.requirements,
      ctx.paymentRequired?.extensions ?? ctx.paymentPayload.extensions,
    )) {
      const result = await hook(ctx);
      if (result && "recovered" in result && result.recovered) {
        return { recovered: true };
      }
    }
    return undefined;
  }

  /**
   * Creates a payment payload based on a PaymentRequired response.
   *
   * Automatically extracts x402Version, resource, and extensions from the PaymentRequired
   * response and constructs a complete PaymentPayload with the accepted requirements.
   *
   * @param paymentRequired - The PaymentRequired response from the server
   * @returns Promise resolving to the complete payment payload
   */
  async createPaymentPayload(
    paymentRequired: PaymentRequired,
  ): Promise<PaymentPayload> {
    // Serialize payload creation: expectation and recipient anchors are checked
    // synchronously but recorded after the async scheme call, so two concurrent
    // first calls on a fresh client could both pass an empty-ledger check.
    // Chaining makes check+anchor atomic per client.
    const run = this.payloadChain.then(() => this.createPaymentPayloadInner(paymentRequired));
    this.payloadChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Inner payload creation, always entered via {@link createPaymentPayload}'s
   * serialization chain.
   *
   * @param paymentRequired - The PaymentRequired response from the server
   * @returns Promise resolving to the complete payment payload
   */
  private async createPaymentPayloadInner(
    paymentRequired: PaymentRequired,
  ): Promise<PaymentPayload> {
    const clientSchemesByNetwork = this.registeredClientSchemes.get(paymentRequired.x402Version);
    if (!clientSchemesByNetwork) {
      throw new Error(`No client registered for x402 version: ${paymentRequired.x402Version}`);
    }

    const resourceUrl =
      paymentRequired.x402Version === 1
        ? (paymentRequired.accepts[0] as unknown as PaymentRequirementsV1 | undefined)?.resource
        : paymentRequired.resource?.url;
    const requirements = this.selectPaymentRequirements(
      paymentRequired.x402Version,
      paymentRequired.accepts,
      resourceUrl,
    );

    const context: PaymentCreationContext = {
      paymentRequired,
      selectedRequirements: requirements,
    };

    for (const hook of this.getLabeledHooks(
      "beforePaymentCreation",
      paymentRequired.x402Version,
      requirements,
      paymentRequired.extensions,
    )) {
      const result = await hook(context);
      if (result && "abort" in result && result.abort) {
        throw new Error(`Payment creation aborted: ${result.reason}`);
      }
    }

    try {
      const schemeNetworkClient = findByNetworkAndScheme(clientSchemesByNetwork, requirements.scheme, requirements.network);
      if (!schemeNetworkClient) {
        throw new Error(`No client registered for scheme: ${requirements.scheme} and network: ${requirements.network}`);
      }

      const partialPayload = await schemeNetworkClient.createPaymentPayload(
        paymentRequired.x402Version,
        requirements,
        {
          extensions: paymentRequired.extensions,
          maxAmountPerPayment: resolveAtomicSpendCap(
            this.spendControls,
            requirements,
            schemeNetworkClient.findDefaultAsset?.(requirements.asset, requirements.network),
          ),
        },
      );

      this.anchorQuoteExpectation(paymentRequired.x402Version, resourceUrl, requirements);

      let paymentPayload: PaymentPayload;
      if (partialPayload.x402Version == 1) {
        paymentPayload = partialPayload as PaymentPayload;
      } else {
        // Merge server-declared extensions with any scheme-provided extensions.
        // Scheme extensions overlay on top (e.g., EIP-2612 info enriches server declaration).
        const mergedExtensions = this.mergeExtensions(
          paymentRequired.extensions,
          partialPayload.extensions,
        );

        paymentPayload = {
          x402Version: partialPayload.x402Version,
          payload: partialPayload.payload,
          extensions: mergedExtensions,
          resource: paymentRequired.resource,
          accepted: requirements,
        };
      }

      // Enrich payload via registered client extensions (for non-scheme extensions)
      paymentPayload = await this.enrichPaymentPayloadWithExtensions(paymentPayload, paymentRequired);

      const createdContext: PaymentCreatedContext = {
        ...context,
        paymentPayload,
      };

      for (const hook of this.getLabeledHooks(
        "afterPaymentCreation",
        paymentRequired.x402Version,
        requirements,
        paymentRequired.extensions,
      )) {
        await hook(createdContext);
      }

      return paymentPayload;
    } catch (error) {
      const failureContext: PaymentCreationFailureContext = {
        ...context,
        error: error as Error,
      };

      for (const hook of this.getLabeledHooks(
        "onPaymentCreationFailure",
        paymentRequired.x402Version,
        requirements,
        paymentRequired.extensions,
      )) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.payload;
        }
      }

      throw error;
    }
  }



  /**
   * Merges server-declared extensions with client extension echoes.
   * Client extension data may add fields, but server-declared fields remain intact.
   * For fields listed in `ADDITIVE_ARRAY_INFO_FIELDS` (e.g. builder-code `s`), a
   * conflicting array is concatenated with client entries first (so a downstream
   * length cap trims server entries rather than the client's) and duplicates
   * removed; a scalar on either side is treated as a single-element array. Every
   * other conflicting array keeps the server's value, same as any other scalar.
   *
   * @param serverExtensions - Extensions declared by the server in the 402 response
   * @param clientExtensions - Extensions provided by the client or scheme
   * @returns The merged extensions object, or undefined if both inputs are undefined
   */
  private mergeExtensions(
    serverExtensions?: Record<string, unknown>,
    clientExtensions?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!clientExtensions) return serverExtensions;
    if (!serverExtensions) return clientExtensions;

    const merged = { ...serverExtensions };
    for (const [key, clientValue] of Object.entries(clientExtensions)) {
      const serverValue = merged[key];
      if (
        serverValue === null ||
        typeof serverValue !== "object" ||
        Array.isArray(serverValue) ||
        clientValue === null ||
        typeof clientValue !== "object" ||
        Array.isArray(clientValue)
      ) {
        merged[key] = clientValue;
        continue;
      }

      const serverRecord = serverValue as Record<string, unknown>;
      const clientRecord = clientValue as Record<string, unknown>;
      const additiveFields = ADDITIVE_ARRAY_INFO_FIELDS[key];
      const extensionValue = { ...serverRecord };
      const pending = [{ target: extensionValue, source: clientRecord }];
      for (const item of pending) {
        for (const [fieldKey, clientFieldValue] of Object.entries(item.source)) {
          const serverFieldValue = item.target[fieldKey];
          if (
            serverFieldValue !== null &&
            typeof serverFieldValue === "object" &&
            !Array.isArray(serverFieldValue) &&
            clientFieldValue !== null &&
            typeof clientFieldValue === "object" &&
            !Array.isArray(clientFieldValue)
          ) {
            const nestedValue = { ...(serverFieldValue as Record<string, unknown>) };
            item.target[fieldKey] = nestedValue;
            pending.push({
              target: nestedValue,
              source: clientFieldValue as Record<string, unknown>,
            });
            continue;
          }

          // A scalar on one side (e.g. builder-code `s` sent as a bare string)
          // merges as a single-element array against an array on the other side.
          // Only additive fields concatenate; other conflicting arrays keep the
          // server's value below, same as any other scalar leaf field.
          if (
            additiveFields?.has(fieldKey) &&
            (Array.isArray(serverFieldValue) || Array.isArray(clientFieldValue))
          ) {
            const serverArray = toComparableArray(serverFieldValue);
            const clientArray = toComparableArray(clientFieldValue);
            if (serverArray && clientArray) {
              item.target[fieldKey] = mergeArraysUnique(clientArray, serverArray);
              continue;
            }
          }

          if (!Object.prototype.hasOwnProperty.call(item.target, fieldKey)) {
            item.target[fieldKey] = clientFieldValue;
          }
        }
      }

      merged[key] = extensionValue;
    }
    return merged;
  }

  /**
   * Enriches a payment payload by calling registered extension hooks.
   * Invokes enrichPaymentPayload for every registered extension, then merges
   * server-declared extension fields back into the result.
   *
   * @param paymentPayload - The payment payload to enrich with extension data
   * @param paymentRequired - The PaymentRequired response containing extension declarations
   * @returns The enriched payment payload with extension data applied
   */
  private async enrichPaymentPayloadWithExtensions(
    paymentPayload: PaymentPayload,
    paymentRequired: PaymentRequired,
  ): Promise<PaymentPayload> {
    if (this.registeredExtensions.size === 0) {
      return paymentPayload;
    }

    let enriched = paymentPayload;
    for (const [, extension] of this.registeredExtensions) {
      if (extension.enrichPaymentPayload) {
        enriched = await extension.enrichPaymentPayload(enriched, paymentRequired);
      }
    }

    return {
      ...enriched,
      extensions: this.mergeExtensions(paymentRequired.extensions, enriched.extensions),
    };
  }

  /**
   * Selects appropriate payment requirements based on registered clients and policies.
   *
   * Selection process:
   * 1. Filter by registered schemes (network + scheme support)
   * 2. Drop accepts with unrecognized `extra.paymentFlow`
   * 3. Enforce spend controls (allowlist, per-asset caps, USD cap on default assets)
   * 4. Apply all registered policies in order
   * 5. Prefer authorization (omit or explicit) over upfront/escrow when both remain
   * 6. Use selector to choose final requirement
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - Array of available payment requirements
   * @param resourceUrl - Resource URL for the quote key (v2: PaymentRequired.resource.url)
   * @returns The selected payment requirements
   */
  private selectPaymentRequirements(
    x402Version: number,
    paymentRequirements: PaymentRequirements[],
    resourceUrl?: string,
  ): PaymentRequirements {
    const clientSchemesByNetwork = this.registeredClientSchemes.get(x402Version);
    if (!clientSchemesByNetwork) {
      throw new Error(`No client registered for x402 version: ${x402Version}`);
    }

    // Step 1: Filter by registered schemes
    const supportedPaymentRequirements = paymentRequirements.filter(requirement => {
      let clientSchemes = findSchemesByNetwork(clientSchemesByNetwork, requirement.network);
      if (!clientSchemes) {
        return false;
      }

      return clientSchemes.has(requirement.scheme);
    })

    if (supportedPaymentRequirements.length === 0) {
      throw new Error(`No network/scheme registered for x402 version: ${x402Version} which comply with the payment requirements. ${JSON.stringify({
        x402Version,
        paymentRequirements,
        x402Versions: Array.from(this.registeredClientSchemes.keys()),
        networks: Array.from(clientSchemesByNetwork.keys()),
        schemes: Array.from(clientSchemesByNetwork.values()).map(schemes => Array.from(schemes.keys())).flat(),
      })}`);
    }

    // Step 2: Drop unrecognized paymentFlow values
    const recognizedFlowRequirements = supportedPaymentRequirements.filter(requirement => {
      const flow = requirement.extra?.paymentFlow;
      return (
        flow == null ||
        flow === "authorization" ||
        flow === "upfront" ||
        flow === "escrow"
      );
    });
    if (recognizedFlowRequirements.length === 0) {
      throw new Error(
        `No payment requirements with a recognized paymentFlow for x402 version: ${x402Version}`,
      );
    }

    // Step 3: Enforce spend controls
    let filteredRequirements = this.applySpendControls(
      x402Version,
      recognizedFlowRequirements,
      clientSchemesByNetwork,
      resourceUrl,
    );

    // Step 4: Apply all policies in order
    for (const policy of this.policies) {
      filteredRequirements = policy(x402Version, filteredRequirements);

      if (filteredRequirements.length === 0) {
        throw new Error(`All payment requirements were filtered out by policies for x402 version: ${x402Version}`);
      }
    }

    // Step 5: Prefer authorization when both post- and pre-handler flows remain
    const authorizationAccepts = filteredRequirements.filter(
      requirement =>
        requirement.extra?.paymentFlow == null ||
        requirement.extra?.paymentFlow === "authorization",
    );
    if (authorizationAccepts.length > 0) {
      filteredRequirements = authorizationAccepts;
    }

    // Step 6: Use selector to choose final requirement
    return this.paymentRequirementsSelector(x402Version, filteredRequirements);
  }

  /**
   * Filter by spend controls (default-asset allowlist → opt-in assets → caps).
   * Keeps any accept that fits so a mixed offer can still pay the affordable option.
   *
   * @param x402Version - Protocol version (v1 uses `maxAmountRequired`)
   * @param requirements - Post scheme/flow filter
   * @param clientSchemesByNetwork - Registered clients for this version
   * @param resourceUrl - Resource URL for the quote key (v2: PaymentRequired.resource.url)
   * @returns Requirements that pass spend controls
   */
  private applySpendControls(
    x402Version: number,
    requirements: PaymentRequirements[],
    clientSchemesByNetwork: Map<string, Map<string, SchemeNetworkClient>>,
    resourceUrl?: string,
  ): PaymentRequirements[] {
    const controls = this.spendControls;
    if (controls === false) {
      return requirements;
    }

    const rawAmountOf = (requirement: PaymentRequirements) =>
      x402Version === 1
        ? (requirement as unknown as PaymentRequirementsV1).maxAmountRequired
        : requirement.amount;
    const schemeFor = (requirement: PaymentRequirements) =>
      findByNetworkAndScheme(
        clientSchemesByNetwork,
        requirement.scheme,
        requirement.network,
      );
    const defaultAssetFor = (requirement: PaymentRequirements) =>
      schemeFor(requirement)?.findDefaultAsset?.(requirement.asset, requirement.network);
    const findAssetEntry = (requirement: PaymentRequirements) =>
      findSpendControlAssetEntry(controls, requirement, defaultAssetFor(requirement));
    const allowAnyAsset = controls.allowedAssets === true;

    let filtered = allowAnyAsset
      ? requirements
      : requirements.filter(requirement => {
          if (defaultAssetFor(requirement) != null) {
            return true;
          }
          return findAssetEntry(requirement) != null;
        });
    if (filtered.length === 0) {
      throw new Error(
        `All payment requirements were rejected by spendControls: only default assets ` +
          `or entries in spendControls.allowedAssets are allowed. Add an allowedAssets ` +
          `entry for non-default tokens, set allowedAssets: true, or set spendControls: false.`,
      );
    }

    const usdLimit =
      controls.maxAmountPerPayment === false
        ? false
        : (controls.maxAmountPerPayment ?? DEFAULT_MAX_AMOUNT_PER_PAYMENT);

    const beforeAmountCaps = filtered;
    let rejectedByAssetCap = false;
    let rejectedUsdSymbol: string | undefined;

    filtered = filtered.filter(requirement => {
      const defaultAsset = defaultAssetFor(requirement);
      const assetEntry = findSpendControlAssetEntry(controls, requirement, defaultAsset);
      const cap = resolveAtomicSpendCap(controls, requirement, defaultAsset);
      if (cap === undefined) {
        return true;
      }

      const rawAmount = rawAmountOf(requirement);
      if (!isAtomicAmount(rawAmount)) {
        if (assetEntry?.maxAmountPerPayment != null) {
          rejectedByAssetCap = true;
          return false;
        }
        // Decimal ledger value (e.g. XRPL IOU "0.01") — 1:1 USD vs the Money cap.
        if (usdLimit === false) {
          return true;
        }
        const valueScaled = BigInt(convertToTokenAmount(rawAmount, 18));
        const capScaled = BigInt(convertToTokenAmount(parseMoney(usdLimit).amount, 18));
        const ok = valueScaled <= capScaled;
        if (!ok) rejectedUsdSymbol = defaultAsset?.symbol;
        return ok;
      }

      const ok = BigInt(rawAmount) <= BigInt(cap);
      if (!ok) {
        if (assetEntry?.maxAmountPerPayment != null) {
          rejectedByAssetCap = true;
        } else {
          rejectedUsdSymbol = defaultAsset?.symbol;
        }
      }
      return ok;
    });

    if (filtered.length === 0) {
      if (
        rejectedByAssetCap &&
        beforeAmountCaps.every(requirement => {
          const entry = findAssetEntry(requirement);
          return entry?.maxAmountPerPayment != null;
        })
      ) {
        throw new Error(
          `All payment requirements were rejected by spendControls.allowedAssets maxAmountPerPayment. ` +
            `Raise the per-asset cap, or omit maxAmountPerPayment to allow uncapped ` +
            `(default assets then fall back to the top-level USD cap).`,
        );
      }
      throw new Error(
        `All payment requirements were rejected by spendControls.maxAmountPerPayment ` +
          `(${String(usdLimit)}${rejectedUsdSymbol ? `, including ${rejectedUsdSymbol}` : ""}). ` +
          `Raise maxAmountPerPayment, set it to false to disable, ` +
          `set allowedAssets[].maxAmountPerPayment for a per-asset atomic cap, ` +
          `or set spendControls: false to disable all spend controls.`,
      );
    }

    return this.applyExpectedAmount(x402Version, filtered, defaultAssetFor, resourceUrl);
  }

  /**
   * Enforce the caller-anchored price expectation (spendControls.expectedAmount).
   * Runs after the asset allowlist and amount caps, still pre-signature. Fail-closed:
   * a mismatch empties the candidate set and throws {@link QuoteMismatchError}.
   *
   * @param x402Version - Protocol version (v1 uses `maxAmountRequired`)
   * @param requirements - Post allowlist/cap filter
   * @param defaultAssetFor - Default-asset resolver (for Money -> atomic conversion)
   * @param resourceUrl - Resource URL for the quote key (v2: PaymentRequired.resource.url)
   * @returns Requirements matching the expectation within tolerance
   */
  private applyExpectedAmount(
    x402Version: number,
    requirements: PaymentRequirements[],
    defaultAssetFor: (requirement: PaymentRequirements) => DefaultAsset | undefined,
    resourceUrl?: string,
  ): PaymentRequirements[] {
    const controls = this.spendControls;
    if (controls === false || (!controls.expectedAmount && !controls.expectedPayTo)) {
      return requirements;
    }

    const tolerance = controls.expectedAmountTolerance ?? 1.0;
    if (controls.expectedAmount && !(tolerance >= 1.0)) {
      throw new Error(
        `spendControls.expectedAmountTolerance must be >= 1.0 (a multiplier on the expectation); got ${tolerance}`,
      );
    }
    const TOL_SCALE = 1_000_000n;
    const tolScaled = BigInt(Math.round(tolerance * Number(TOL_SCALE)));

    const rawAmountOf = (requirement: PaymentRequirements) =>
      x402Version === 1
        ? (requirement as unknown as PaymentRequirementsV1).maxAmountRequired
        : requirement.amount;

    const mismatches: Array<{
      requirement: PaymentRequirements;
      expected: string;
      source: QuoteExpectationSource;
      field: "amount" | "payTo";
    }> = [];
    const unsupported: Array<{
      requirement: PaymentRequirements;
      reason: "non-atomic-amount" | "unknown-asset-decimals";
    }> = [];

    const filtered = requirements.filter(requirement => {
      // Explicit recipient expectation (whenever configured): the recipient
      // must be caller-approved, not merely consistent with history.
      if (
        controls.expectedPayTo !== undefined &&
        !sameRecipient(requirement.payTo, controls.expectedPayTo)
      ) {
        mismatches.push({
          requirement,
          expected: controls.expectedPayTo,
          source: "caller-config",
          field: "payTo",
        });
        return false;
      }

      // Recipient binding (expectedAmount modes): the first payTo committed for
      // this (resource, scheme, network, asset) tuple sticks; a substituted
      // recipient on a known quote is a mismatch, regardless of amount.
      const boundPayTo = this.recipientLedger.get(
        this.recipientKeyFor(resourceUrl, requirement),
      );
      if (boundPayTo !== undefined && !sameRecipient(boundPayTo, requirement.payTo)) {
        mismatches.push({
          requirement,
          expected: boundPayTo,
          source: "quote-ledger",
          field: "payTo",
        });
        return false;
      }

      const rawAmount = rawAmountOf(requirement);

      let expectedAtomic: string | undefined;
      let source: QuoteExpectationSource;
      if (controls.expectedAmount === "first-accepted") {
        if (!isAtomicAmount(rawAmount)) {
          // Decimal-ledger amounts (e.g. XRPL IOUs) cannot be compared against
          // the expectation. Fail-closed: skipping the check would sign an
          // unchecked payment; an allowlist entry or higher cap is no substitute.
          unsupported.push({ requirement, reason: "non-atomic-amount" });
          return false;
        }
        source = "quote-ledger";
        expectedAtomic = this.quoteLedger.get(this.quoteKeyFor(resourceUrl, requirement))?.atomic;
        if (expectedAtomic === undefined) {
          // No anchor for this quote key yet: allow; anchored after the next
          // successful payload creation (see anchorQuoteExpectation).
          return true;
        }
      } else if (controls.expectedAmount) {
        if (!isAtomicAmount(rawAmount)) {
          // Same fail-closed rule as above, for the explicit-expectation mode.
          unsupported.push({ requirement, reason: "non-atomic-amount" });
          return false;
        }
        source = "caller-config";
        const defaultAsset = defaultAssetFor(requirement);
        if (!defaultAsset) {
          // Unknown decimals for a non-default asset: the Money expectation
          // cannot be converted. Fail-closed rather than skipping the check.
          unsupported.push({ requirement, reason: "unknown-asset-decimals" });
          return false;
        }
        expectedAtomic = convertToTokenAmount(
          parseMoney(controls.expectedAmount as Money).amount,
          defaultAsset.decimals,
        );
      } else {
        // Only expectedPayTo is set: the recipient check above already ran.
        // Amount representation is irrelevant here — there is no amount
        // expectation to evaluate, so a decimal-ledger amount must pass.
        return true;
      }

      const offered = BigInt(rawAmount);
      const expected = BigInt(expectedAtomic);
      const upper = (expected * tolScaled) / TOL_SCALE;
      const lower = (expected * TOL_SCALE + tolScaled - 1n) / tolScaled;
      const matches = offered <= upper && offered >= lower;
      if (!matches) {
        mismatches.push({ requirement, expected: expectedAtomic, source, field: "amount" });
      }
      return matches;
    });

    if (filtered.length === 0 && mismatches.length > 0) {
      const first = mismatches[0];
      throw new QuoteMismatchError({
        quoteKey: this.quoteKeyFor(resourceUrl, first.requirement),
        expected: first.expected,
        offered:
          first.field === "payTo" ? first.requirement.payTo : rawAmountOf(first.requirement),
        source: first.source,
        field: first.field,
      });
    }
    if (filtered.length === 0 && unsupported.length > 0) {
      const first = unsupported[0];
      throw new QuoteExpectationUnsupportedError({
        quoteKey: this.quoteKeyFor(resourceUrl, first.requirement),
        reason: first.reason,
      });
    }
    return filtered;
  }

  /**
   * Quote key for the expectation ledger: resource url + scheme + network +
   * asset + payTo (the tuple that identifies a recurring price quote).
   *
   * @param resourceUrl - Resource URL, when known
   * @param requirement - Candidate requirement
   * @returns Stable string key
   */
  private quoteKeyFor(resourceUrl: string | undefined, requirement: PaymentRequirements): string {
    return JSON.stringify([
      resourceUrl ?? "",
      requirement.scheme,
      requirement.network,
      requirement.asset,
      canonicalRecipient(requirement.payTo),
    ]);
  }

  /**
   * Recipient key for the recipient ledger: the quote key without payTo, so a
   * payTo-only change on a known quote is detected as recipient substitution.
   *
   * @param resourceUrl - Resource URL, when known
   * @param requirement - Candidate requirement
   * @returns Stable string key
   */
  private recipientKeyFor(
    resourceUrl: string | undefined,
    requirement: PaymentRequirements,
  ): string {
    return JSON.stringify([
      resourceUrl ?? "",
      requirement.scheme,
      requirement.network,
      requirement.asset,
    ]);
  }

  /**
   * Record bindings after a payload is successfully created — the client-side
   * commitment point (the client never observes settlement):
   * - recipient ledger (both expectedAmount modes): first payTo per
   *   (resource, scheme, network, asset) sticks;
   * - quote ledger ("first-accepted" mode only): first amount per full quote
   *   key sticks.
   *
   * @param x402Version - Protocol version (v1 uses `maxAmountRequired`)
   * @param resourceUrl - Resource URL for the quote key
   * @param requirements - The requirement a payload was just created for
   */
  private anchorQuoteExpectation(
    x402Version: number,
    resourceUrl: string | undefined,
    requirements: PaymentRequirements,
  ): void {
    const controls = this.spendControls;
    if (controls === false || !controls.expectedAmount) {
      return;
    }
    const rKey = this.recipientKeyFor(resourceUrl, requirements);
    if (!this.recipientLedger.has(rKey)) {
      this.recipientLedger.set(rKey, requirements.payTo);
    }
    if (controls.expectedAmount !== "first-accepted") {
      return;
    }
    const rawAmount =
      x402Version === 1
        ? (requirements as unknown as PaymentRequirementsV1).maxAmountRequired
        : requirements.amount;
    if (!isAtomicAmount(rawAmount)) {
      return;
    }
    const key = this.quoteKeyFor(resourceUrl, requirements);
    if (!this.quoteLedger.has(key)) {
      this.quoteLedger.set(key, { atomic: rawAmount, anchoredAt: Date.now() });
    }
  }

  /**
   * Internal method to register a scheme client.
   *
   * @param x402Version - The x402 protocol version
   * @param network - The network to register the client for
   * @param client - The scheme network client to register
   * @returns The x402Client instance for chaining
   */
  private _registerScheme(x402Version: number, network: Network, client: SchemeNetworkClient): x402Client {
    if (!this.registeredClientSchemes.has(x402Version)) {
      this.registeredClientSchemes.set(x402Version, new Map());
    }
    const clientSchemesByNetwork = this.registeredClientSchemes.get(x402Version)!;
    if (!clientSchemesByNetwork.has(network)) {
      clientSchemesByNetwork.set(network, new Map());
    }

    const clientByScheme = clientSchemesByNetwork.get(network)!;
    clientByScheme.set(client.scheme, client);

    if (!this.schemeClientHookAdapters.has(x402Version)) {
      this.schemeClientHookAdapters.set(x402Version, new Map());
    }
    const adaptersByNetwork = this.schemeClientHookAdapters.get(x402Version)!;
    if (!adaptersByNetwork.has(network)) {
      adaptersByNetwork.set(network, new Map());
    }

    const adaptersByScheme = adaptersByNetwork.get(network)!;
    const hooks = client.schemeHooks;
    if (!hooks) {
      adaptersByScheme.delete(client.scheme);
      return this;
    }

    const handles: ClientHookAdapterHandles = {};
    if (hooks.onBeforePaymentCreation) {
      handles.beforePaymentCreation = hooks.onBeforePaymentCreation;
    }
    if (hooks.onAfterPaymentCreation) {
      handles.afterPaymentCreation = hooks.onAfterPaymentCreation;
    }
    if (hooks.onPaymentCreationFailure) {
      handles.onPaymentCreationFailure = hooks.onPaymentCreationFailure;
    }
    if (hooks.onPaymentResponse) {
      handles.onPaymentResponse = hooks.onPaymentResponse;
    }

    if (Object.keys(handles).length > 0) {
      adaptersByScheme.set(client.scheme, handles);
    } else {
      adaptersByScheme.delete(client.scheme);
    }

    return this;
  }

  /**
   * Returns manual hooks followed by the selected scheme hook and declared extension hooks.
   *
   * @param phase - Hook slot to collect
   * @param x402Version - Protocol version for the selected requirement
   * @param requirements - Selected payment requirement
   * @param declaredExtensions - Extension declarations that scope extension hooks
   * @returns Hooks in invocation order
   */
  private getLabeledHooks<P extends ClientHookPhase>(
    phase: P,
    x402Version: number,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
  ): Array<NonNullable<ClientHookAdapterHandles[P]>> {
    let manual: Array<NonNullable<ClientHookAdapterHandles[P]>>;
    switch (phase) {
      case "beforePaymentCreation":
        manual = this.beforePaymentCreationHooks as Array<
          NonNullable<ClientHookAdapterHandles[P]>
        >;
        break;
      case "afterPaymentCreation":
        manual = this.afterPaymentCreationHooks as Array<
          NonNullable<ClientHookAdapterHandles[P]>
        >;
        break;
      case "onPaymentCreationFailure":
        manual = this.onPaymentCreationFailureHooks as Array<
          NonNullable<ClientHookAdapterHandles[P]>
        >;
        break;
      case "onPaymentResponse":
        manual = this.paymentResponseHooks as Array<NonNullable<ClientHookAdapterHandles[P]>>;
        break;
    }

    const out: Array<NonNullable<ClientHookAdapterHandles[P]>> = [...manual];
    const adaptersByNetwork = this.schemeClientHookAdapters.get(x402Version);
    const schemeAdapter = adaptersByNetwork
      ? findByNetworkAndScheme(adaptersByNetwork, requirements.scheme, requirements.network)
      : undefined;
    const hook = schemeAdapter?.[phase];
    if (hook !== undefined) {
      out.push(hook);
    }
    if (!declaredExtensions) {
      return out;
    }

    const extensionHookKey = this.getClientExtensionHookKey(phase);
    for (const [extensionKey, extension] of this.registeredExtensions) {
      if (!(extensionKey in declaredExtensions)) continue;

      const extensionHook = extension.hooks?.[extensionHookKey];
      if (!extensionHook) continue;

      type HookFn = NonNullable<ClientHookAdapterHandles[P]>;
      type HookContext = Parameters<HookFn>[0];
      out.push((async (ctx: HookContext) => {
        return (
          extensionHook as (
            declaration: unknown,
            context: HookContext,
          ) => ReturnType<HookFn>
        )(declaredExtensions[extensionKey], ctx);
      }) as HookFn);
    }
    return out;
  }

  /**
   * Maps internal hook phases to extension hook names.
   *
   * @param phase - Internal hook phase
   * @returns Extension hook key for the phase
   */
  private getClientExtensionHookKey<P extends ClientHookPhase>(
    phase: P,
  ): keyof ClientExtensionHooks {
    switch (phase) {
      case "beforePaymentCreation":
        return "onBeforePaymentCreation";
      case "afterPaymentCreation":
        return "onAfterPaymentCreation";
      case "onPaymentCreationFailure":
        return "onPaymentCreationFailure";
      case "onPaymentResponse":
        return "onPaymentResponse";
    }
  }
}

/**
 * Concatenates two arrays, keeping client entries first (so a downstream length
 * cap trims server entries rather than the client's) and dropping duplicates
 * (deep equality) wherever they occur, including within either input array.
 *
 * @param client - Client-provided array values
 * @param server - Server-declared array values
 * @returns Deduplicated concatenation
 */
function mergeArraysUnique(client: unknown[], server: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const item of [...client, ...server]) {
    if (!merged.some(existing => deepEqual(existing, item))) {
      merged.push(item);
    }
  }
  return merged;
}
