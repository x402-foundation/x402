import {
  SettleError,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
  SupportedKind,
  FacilitatorCapabilityError,
} from "../types/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
} from "../types/payments";
import {
  PaymentFlowName,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
} from "../types/mechanisms";
import { Price, Network, ResourceServerExtension, ResourceServerExtensionHooks } from "../types";
import type { DeepReadonly } from "../types/readonly";
import {
  ADDITIVE_ARRAY_INFO_FIELDS,
  ADDITIVE_ARRAY_MAX_LENGTHS,
  SERVER_OWNED_INFO_FIELDS,
  deepEqual,
  convertToTokenAmount,
  findByNetworkAndScheme,
  toComparableArray,
} from "../utils";
import {
  assertAcceptsAllowlistedAfterExtensionEnrich,
  assertAcceptsAdditiveExtraAfterSchemeEnrich,
  assertAdditivePayloadEnrichment,
  assertAdditiveSettlementExtra,
  assertSettleResponseCoreUnchanged,
  mergeAdditiveSettlementExtra,
  snapshotPaymentRequirementsList,
  snapshotSettleResponseCore,
} from "./hookPolicy";
import {
  applyPaymentFlowWireExtra,
  resolvePaymentFlow,
  resolvePaymentFlowPhases,
} from "./paymentFlow";
import { FacilitatorClient, HTTPFacilitatorClient } from "../http/httpFacilitatorClient";
import { x402Version } from "..";

/**
 * Which settle invocation is running for a payment.
 *
 * - `before-handler` — settle before the resource handler (e.g. escrow deposit)
 * - `after-handler` — settle after the resource handler (authorization charge, escrow charge)
 * - `cancel` — refund/close settle from verified-payment cancellation
 *
 * Settle lifecycle hooks (`beforeSettle`, `afterSettle`, `onSettleFailure`,
 * `enrichSettlementPayload`, `enrichSettlementResponse`) fire once per settle.
 * Multi-settle flows (`escrow`) therefore invoke them more than once; branch on
 * this field when a hook has side effects that must not double-run.
 */
export type SettlePhase = "before-handler" | "after-handler" | "cancel";

/**
 * Configuration for a protected resource
 * Only contains payment-specific configuration, not resource metadata
 */
export interface ResourceConfig {
  scheme: string;
  /**
   * Payment recipient. Use a **vacant** value (`""` or whitespace-only) when an extension must
   * fill `payTo` during `enrichPaymentRequiredResponse`; non-vacant values are **immutable** there
   * so extensions cannot redirect funds to an arbitrary address.
   */
  payTo: string;
  price: Price;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>; // Scheme-specific additional data
}

/**
 * Context for `enrichPaymentRequiredResponse`. Extensions may merge extension payload via the
 * return value. In-place edits to `paymentRequiredResponse.accepts` are **allowlisted** only
 * (see {@link assertAcceptsAllowlistedAfterExtensionEnrich}): `scheme`, `network`, and
 * `maxTimeoutSeconds` are immutable; `payTo`, `amount`, and `asset` may change only when the
 * baseline value was vacant; `extra` may add keys but must not change or remove baseline keys.
 * `extra.paymentFlow` and `extra.assetTransferMethod` are protocol-reserved and immutable
 * during enrichment (enrichment must not add or rewrite them).
 */
export interface PaymentRequiredContext {
  requirements: PaymentRequirements[];
  resourceInfo: ResourceInfo;
  error?: string;
  paymentRequiredResponse: PaymentRequired;
  transportContext?: unknown;
}

/**
 * Verify / settle lifecycle hook context: treat as **read-only** for core protocol fields.
 * Control flow uses **abort** / **recover** return values only, not in-place mutation.
 */
export interface VerifyContext {
  paymentPayload: DeepReadonly<PaymentPayload>;
  requirements: DeepReadonly<PaymentRequirements>;
  declaredExtensions: DeepReadonly<Record<string, unknown>>;
  transportContext?: unknown;
}

export interface VerifyResultContext extends VerifyContext {
  result: DeepReadonly<VerifyResponse>;
}

/**
 * Optional acknowledgement body returned to the caller when an `AfterVerifyHook`
 * requests that the resource handler be skipped for a self-contained operation
 * (e.g. cooperative refund). Travels in-process only — never on the facilitator wire.
 */
export interface SkipHandlerDirective {
  contentType?: string;
  body?: unknown;
}

export type ResourceVerifyRespone = VerifyResponse & {
  skipHandler?: SkipHandlerDirective;
};

export interface VerifyFailureContext extends VerifyContext {
  error: Error;
}

export interface SettleContext {
  paymentPayload: DeepReadonly<PaymentPayload>;
  requirements: DeepReadonly<PaymentRequirements>;
  declaredExtensions: DeepReadonly<Record<string, unknown>>;
  phase: SettlePhase;
  transportContext?: unknown;
}

export interface SettleResultContext extends SettleContext {
  result: DeepReadonly<SettleResponse>;
}

export interface SettleFailureContext extends SettleContext {
  error: Error;
}

/**
 * Generic (scheme/network-agnostic) settle error reason meaning a
 * transaction broadcast successfully but its receipt/confirmation wait
 * failed — non-terminal, and always carries the broadcast transaction hash
 * so a caller can reconcile onchain. Duplicated here (rather than imported
 * from a mechanism package) so core does not depend on the mechanisms
 * packages, mirroring Go's `x402.ErrSettlementPending`
 * (`go/errors.go`) and its mechanism-level counterparts
 * (`evm.ErrSettlementPending`, `svm.ErrSettlementPending`). Used by
 * {@link x402ResourceServer.settlePayment}'s single automatic settle retry.
 */
const SETTLEMENT_PENDING_REASON = "settlement_pending";

export type VerifiedPaymentCancellationReason =
  | "handler_threw"
  | "handler_failed"
  | "after_verify_aborted";

export interface VerifiedPaymentCanceledContext extends SettleContext {
  reason: VerifiedPaymentCancellationReason;
  error?: unknown;
  responseStatus?: number;
  readonly settledPhases: readonly SettlePhase[];
}

export interface VerifiedPaymentCancelOptions {
  reason: VerifiedPaymentCancellationReason;
  error?: unknown;
  responseStatus?: number;
}

export interface CompletedSettlement {
  phase: SettlePhase;
  flow: PaymentFlowName;
  result: SettleResponse;
  requirements: PaymentRequirements;
}

/**
 * Failure-path cancel hook for a payment that already passed pre-handler gates.
 * Created by {@link x402ResourceServer.createPaymentCancellationDispatcher}.
 * Success-path settle results are not stored here — callers pass
 * `beforeHandlerSettlement` into settlement separately when echoing PAYMENT-RESPONSE.
 */
export interface PaymentCancellationDispatcher {
  cancel(options: VerifiedPaymentCancelOptions): Promise<SettleResponse | void>;
}

export type BeforeVerifyHook = (
  context: VerifyContext,
) => Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
>;

export type AfterVerifyHook = (
  context: VerifyResultContext,
) => Promise<
  | void
  | { skipHandler: true; response?: SkipHandlerDirective }
  | { abort: true; reason: string; message?: string }
>;

export type OnVerifyFailureHook = (
  context: VerifyFailureContext,
) => Promise<void | { recovered: true; result: VerifyResponse }>;

export type BeforeSettleHook = (
  context: SettleContext,
) => Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
>;

export type AfterSettleHook = (context: SettleResultContext) => Promise<void>;

export type OnSettleFailureHook = (
  context: SettleFailureContext,
) => Promise<void | { recovered: true; result: SettleResponse }>;

export type OnVerifiedPaymentCanceledHook = (
  context: VerifiedPaymentCanceledContext,
) => Promise<void>;

/**
 * Optional overrides for settlement parameters.
 * Used to support partial settlement (e.g., upto scheme billing by actual usage).
 *
 * Note: Overriding the amount to a value different from the agreed-upon
 * `PaymentRequirements.amount` is only valid in schemes that explicitly support
 * partial settlement, such as the `upto` scheme. Using this with standard
 * x402 schemes (e.g., `exact`) will likely cause settlement verification to fail.
 */
export type ExtensionValidationResult =
  | { valid: true }
  | { valid: false; invalidReason: "extension_echo_mismatch"; extensionKey: string };

export interface SettlementOverrides {
  /**
   * Amount to settle. Supports three formats:
   *
   * - **Raw atomic units** — e.g., `"1000"` settles exactly 1000 atomic units.
   * - **Percent** — e.g., `"50%"` settles 50% of `PaymentRequirements.amount`.
   *   Supports up to two decimal places (e.g., `"33.33%"`). The result is floored
   *   to the nearest atomic unit.
   * - **Dollar price** — e.g., `"$0.05"` converts a USD-denominated price to
   *   atomic units. Decimals are determined from the registered scheme's
   *   `getAssetDecimals` method, falling back to 6 (standard for USDC stablecoins).
   *   The result is rounded to the nearest atomic unit.
   *
   * The resolved amount must be <= the authorized maximum in `PaymentRequirements`.
   *
   * Note: Setting this to an amount other than `PaymentRequirements.amount` is
   * only valid in schemes that support partial settlement, such as `upto`.
   */
  amount?: string;
}

/**
 * Resolves a settlement override amount string to a final atomic-unit string.
 *
 * Supports three input formats (see {@link SettlementOverrides.amount}):
 * - Raw atomic units: `"1000"`
 * - Percent of `PaymentRequirements.amount`: `"50%"`
 * - Dollar price: `"$0.05"` (converted using the provided decimals)
 *
 * @param rawAmount - The override amount string (e.g., `"1000"`, `"50%"`, `"$0.05"`)
 * @param requirements - The payment requirements containing the base amount
 * @param decimals - Decimal precision for dollar-format conversion. Required for `$…` amounts.
 * @returns The resolved amount as an atomic-unit string
 */
export function resolveSettlementOverrideAmount(
  rawAmount: string,
  requirements: PaymentRequirements,
  decimals?: number,
): string {
  let resolved: string;

  // Percent format: "50%" or "33.33%"
  const percentMatch = rawAmount.match(/^(\d+(?:\.\d{0,2})?)%$/);
  if (percentMatch) {
    const [intPart, decPart = ""] = percentMatch[1].split(".");
    const scaledPercent = BigInt(intPart) * 100n + BigInt(decPart.padEnd(2, "0").slice(0, 2));
    const base = BigInt(requirements.amount);
    resolved = ((base * scaledPercent) / 10000n).toString();
  } else {
    // Dollar price format: "$0.05"
    const dollarMatch = rawAmount.match(/^\$(\d+(?:\.\d+)?)$/);
    if (dollarMatch) {
      if (decimals === undefined) {
        throw new Error(
          `Cannot convert dollar settlement override "${rawAmount}" to atomic units: ` +
            `asset decimals are unknown. Pass an atomic amount or register the asset.`,
        );
      }
      resolved = convertToTokenAmount(dollarMatch[1], decimals);
    } else {
      // Raw atomic units (existing behavior)
      resolved = rawAmount;
    }
  }

  // SettlementOverrides.amount's own contract: the resolved amount must be
  // <= the authorized maximum in PaymentRequirements, for every format above.
  if (BigInt(resolved) > BigInt(requirements.amount)) {
    throw new Error(
      `Settlement override amount "${rawAmount}" resolves to ${resolved} atomic units, ` +
        `which exceeds the authorized maximum of ${requirements.amount} in PaymentRequirements.`,
    );
  }

  return resolved;
}

type HookAdapterHandles = {
  beforeVerify?: BeforeVerifyHook;
  afterVerify?: AfterVerifyHook;
  onVerifyFailure?: OnVerifyFailureHook;
  beforeSettle?: BeforeSettleHook;
  afterSettle?: AfterSettleHook;
  onSettleFailure?: OnSettleFailureHook;
  onVerifiedPaymentCanceled?: OnVerifiedPaymentCanceledHook;
};

type ExtensionAdapterHandles = HookAdapterHandles;
type SchemeAdapterHandles = HookAdapterHandles;

/** Keys shared by adapter handles and manual `*Hooks` arrays on the server. */
type ResourceServerHookPhase = keyof HookAdapterHandles;

type ResourceServerManualHookArrayKey = `${ResourceServerHookPhase}Hooks`;

/**
 * Core x402 protocol server for resource protection
 * Transport-agnostic implementation of the x402 payment protocol
 */
export class x402ResourceServer {
  private facilitatorClients: FacilitatorClient[];
  private registeredServerSchemes: Map<string, Map<string, SchemeNetworkServer>> = new Map();
  private schemeHookAdapters: Map<string, Map<string, SchemeAdapterHandles>> = new Map();
  private supportedResponsesMap: Map<number, Map<string, Map<string, SupportedResponse>>> =
    new Map();
  private facilitatorClientsMap: Map<number, Map<string, Map<string, FacilitatorClient>>> =
    new Map();
  private registeredExtensions: Map<string, ResourceServerExtension> = new Map();
  private extensionHookAdapters = new Map<string, ExtensionAdapterHandles>();

  private beforeVerifyHooks: BeforeVerifyHook[] = [];
  private afterVerifyHooks: AfterVerifyHook[] = [];
  private onVerifyFailureHooks: OnVerifyFailureHook[] = [];
  private beforeSettleHooks: BeforeSettleHook[] = [];
  private afterSettleHooks: AfterSettleHook[] = [];
  private onSettleFailureHooks: OnSettleFailureHook[] = [];
  private onVerifiedPaymentCanceledHooks: OnVerifiedPaymentCanceledHook[] = [];

  /**
   * Creates a new x402ResourceServer instance.
   *
   * @param facilitatorClients - Optional facilitator client(s) for payment processing
   */
  constructor(facilitatorClients?: FacilitatorClient | FacilitatorClient[]) {
    // Normalize facilitator clients to array
    if (!facilitatorClients) {
      // No clients provided, create a default HTTP client
      this.facilitatorClients = [new HTTPFacilitatorClient()];
    } else if (Array.isArray(facilitatorClients)) {
      // Array of clients provided
      this.facilitatorClients =
        facilitatorClients.length > 0 ? facilitatorClients : [new HTTPFacilitatorClient()];
    } else {
      // Single client provided
      this.facilitatorClients = [facilitatorClients];
    }
  }

  /**
   * Register a scheme/network server implementation.
   *
   * @param network - The network identifier
   * @param server - The scheme/network server implementation
   * @returns The x402ResourceServer instance for chaining
   */
  register(network: Network, server: SchemeNetworkServer): x402ResourceServer {
    if (!this.registeredServerSchemes.has(network)) {
      this.registeredServerSchemes.set(network, new Map());
    }

    const serverByScheme = this.registeredServerSchemes.get(network)!;
    serverByScheme.set(server.scheme, server);

    if (!this.schemeHookAdapters.has(network)) {
      this.schemeHookAdapters.set(network, new Map());
    }

    const hooksByScheme = this.schemeHookAdapters.get(network)!;
    const hooks = server.schemeHooks;
    if (!hooks) {
      hooksByScheme.delete(server.scheme);
      return this;
    }

    const handles: SchemeAdapterHandles = {};
    if (hooks.onBeforeVerify) handles.beforeVerify = hooks.onBeforeVerify;
    if (hooks.onAfterVerify) handles.afterVerify = hooks.onAfterVerify;
    if (hooks.onVerifyFailure) handles.onVerifyFailure = hooks.onVerifyFailure;
    if (hooks.onBeforeSettle) handles.beforeSettle = hooks.onBeforeSettle;
    if (hooks.onAfterSettle) handles.afterSettle = hooks.onAfterSettle;
    if (hooks.onSettleFailure) handles.onSettleFailure = hooks.onSettleFailure;
    if (hooks.onVerifiedPaymentCanceled) {
      handles.onVerifiedPaymentCanceled = hooks.onVerifiedPaymentCanceled;
    }

    if (Object.keys(handles).length > 0) {
      hooksByScheme.set(server.scheme, handles);
    } else {
      hooksByScheme.delete(server.scheme);
    }

    return this;
  }

  /**
   * Check if a scheme is registered for a given network.
   *
   * @param network - The network identifier
   * @param scheme - The payment scheme name
   * @returns True if the scheme is registered for the network, false otherwise
   */
  hasRegisteredScheme(network: Network, scheme: string): boolean {
    return !!findByNetworkAndScheme(this.registeredServerSchemes, scheme, network);
  }

  /**
   * Get the registered scheme implementation for a network and scheme name.
   *
   * @param network - The network identifier
   * @param scheme - The payment scheme name
   * @returns The registered scheme, or undefined if none is registered
   */
  getRegisteredScheme(network: Network, scheme: string): SchemeNetworkServer | undefined {
    return findByNetworkAndScheme(this.registeredServerSchemes, scheme, network);
  }

  /**
   * Returns the decimal precision for display of the asset in the given payment
   * requirements. Looks up the registered scheme and delegates to getAssetDecimals
   * when available. Falls back to 6 for display-only callers. Settlement `$…`
   * overrides must not use this fallback — they throw when decimals are unknown.
   *
   * @param requirements - The payment requirements containing scheme, network, and asset
   * @returns The number of decimal places for the asset
   */
  getAssetDecimalsForRequirements(requirements: PaymentRequirements): number {
    const scheme = findByNetworkAndScheme(
      this.registeredServerSchemes,
      requirements.scheme,
      requirements.network as Network,
    );
    return (
      scheme?.getAssetDecimals?.(requirements.asset ?? "", requirements.network as Network) ?? 6
    );
  }

  /**
   * Registers a resource server extension (enrichment and optional verify/settle hooks).
   * Re-registering the same key overwrites; omitting `hooks` removes adapter handles for that key.
   *
   * @param extension - Extension definition including `key` and optional `hooks`
   * @returns This server instance for chaining
   */
  registerExtension(extension: ResourceServerExtension): this {
    this.registeredExtensions.set(extension.key, extension);
    const extensionKey = extension.key;
    const extensionHooks = extension.hooks;
    if (!extensionHooks) {
      this.extensionHookAdapters.delete(extensionKey);
      return this;
    }
    const handles: ExtensionAdapterHandles = {};

    const bindExtensionHookAdapter = <
      ExtKey extends keyof ResourceServerExtensionHooks,
      Phase extends ResourceServerHookPhase,
    >(
      extensionHookKey: ExtKey,
      adapterPhase: Phase,
    ): void => {
      const impl = extensionHooks[extensionHookKey];
      if (!impl) return;

      type AdapterContext = Parameters<NonNullable<ExtensionAdapterHandles[Phase]>>[0];

      handles[adapterPhase] = (async (ctx: AdapterContext) => {
        if (ctx.declaredExtensions[extensionKey] === undefined) return;
        return (impl as (declaration: unknown, context: AdapterContext) => Promise<unknown>)(
          ctx.declaredExtensions[extensionKey],
          ctx,
        );
      }) as ExtensionAdapterHandles[Phase];
    };

    bindExtensionHookAdapter("onBeforeVerify", "beforeVerify");
    bindExtensionHookAdapter("onAfterVerify", "afterVerify");
    bindExtensionHookAdapter("onVerifyFailure", "onVerifyFailure");
    bindExtensionHookAdapter("onBeforeSettle", "beforeSettle");
    bindExtensionHookAdapter("onAfterSettle", "afterSettle");
    bindExtensionHookAdapter("onSettleFailure", "onSettleFailure");
    bindExtensionHookAdapter("onVerifiedPaymentCanceled", "onVerifiedPaymentCanceled");
    if (Object.keys(handles).length > 0) {
      this.extensionHookAdapters.set(extensionKey, handles);
    } else {
      this.extensionHookAdapters.delete(extensionKey);
    }
    return this;
  }

  /**
   * Check if an extension is registered.
   *
   * @param key - The extension key
   * @returns True if the extension is registered
   */
  hasExtension(key: string): boolean {
    return this.registeredExtensions.has(key);
  }

  /**
   * Get all registered extensions.
   *
   * @returns Array of registered extensions
   */
  getExtensions(): ResourceServerExtension[] {
    return Array.from(this.registeredExtensions.values());
  }

  /**
   * Enriches declared extensions using registered extension hooks.
   *
   * @param declaredExtensions - Extensions declared on the route
   * @param transportContext - Transport-specific context (HTTP, A2A, MCP, etc.)
   * @returns Enriched extensions map
   */
  enrichExtensions(
    declaredExtensions: Record<string, unknown>,
    transportContext: unknown,
  ): Record<string, unknown> {
    const enriched: Record<string, unknown> = {};

    for (const [key, declaration] of Object.entries(declaredExtensions)) {
      const extension = this.registeredExtensions.get(key);

      if (extension?.enrichDeclaration) {
        try {
          enriched[key] = extension.enrichDeclaration(declaration, transportContext);
        } catch (error) {
          this.warnExtensionHookFailure(key, "enrichDeclaration", error);
          enriched[key] = declaration;
        }
      } else {
        enriched[key] = declaration;
      }
    }

    return enriched;
  }

  /**
   * Register a hook to execute before payment verification.
   * Can abort verification by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onBeforeVerify(hook: BeforeVerifyHook): x402ResourceServer {
    this.beforeVerifyHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after successful payment verification.
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onAfterVerify(hook: AfterVerifyHook): x402ResourceServer {
    this.afterVerifyHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when payment verification fails.
   * Can recover from failure by returning { recovered: true, result: VerifyResponse }
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onVerifyFailure(hook: OnVerifyFailureHook): x402ResourceServer {
    this.onVerifyFailureHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute before payment settlement.
   * Can abort settlement by returning { abort: true, reason: string }
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onBeforeSettle(hook: BeforeSettleHook): x402ResourceServer {
    this.beforeSettleHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute after successful payment settlement.
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onAfterSettle(hook: AfterSettleHook): x402ResourceServer {
    this.afterSettleHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when payment settlement fails.
   * Can recover from failure by returning { recovered: true, result: SettleResponse }
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onSettleFailure(hook: OnSettleFailureHook): x402ResourceServer {
    this.onSettleFailureHooks.push(hook);
    return this;
  }

  /**
   * Register a hook to execute when verified payment work is canceled before settlement.
   *
   * @param hook - The hook function to register
   * @returns The x402ResourceServer instance for chaining
   */
  onVerifiedPaymentCanceled(hook: OnVerifiedPaymentCanceledHook): x402ResourceServer {
    this.onVerifiedPaymentCanceledHooks.push(hook);
    return this;
  }

  /**
   * Initialize by fetching supported kinds from all facilitators
   * Creates mappings for supported responses and facilitator clients
   * Earlier facilitators in the array get precedence
   */
  async initialize(): Promise<void> {
    // Clear existing mappings
    this.supportedResponsesMap.clear();
    this.facilitatorClientsMap.clear();
    let lastError: Error | undefined;

    // Fetch supported kinds from all facilitator clients
    // Process in order to give precedence to earlier facilitators
    for (const facilitatorClient of this.facilitatorClients) {
      try {
        const supported = await facilitatorClient.getSupported();

        // Process each supported kind (now flat array with version in each element)
        for (const kind of supported.kinds) {
          const x402Version = kind.x402Version;

          // Get or create version map for supported responses
          if (!this.supportedResponsesMap.has(x402Version)) {
            this.supportedResponsesMap.set(x402Version, new Map());
          }
          const responseVersionMap = this.supportedResponsesMap.get(x402Version)!;

          // Get or create version map for facilitator clients
          if (!this.facilitatorClientsMap.has(x402Version)) {
            this.facilitatorClientsMap.set(x402Version, new Map());
          }
          const clientVersionMap = this.facilitatorClientsMap.get(x402Version)!;

          // Get or create network map for responses
          if (!responseVersionMap.has(kind.network)) {
            responseVersionMap.set(kind.network, new Map());
          }
          const responseNetworkMap = responseVersionMap.get(kind.network)!;

          // Get or create network map for clients
          if (!clientVersionMap.has(kind.network)) {
            clientVersionMap.set(kind.network, new Map());
          }
          const clientNetworkMap = clientVersionMap.get(kind.network)!;

          // Only store if not already present (gives precedence to earlier facilitators)
          if (!responseNetworkMap.has(kind.scheme)) {
            responseNetworkMap.set(kind.scheme, supported);
            clientNetworkMap.set(kind.scheme, facilitatorClient);
          }
        }
      } catch (error) {
        lastError = error as Error;
        // Log error but continue with other facilitators
        console.warn(`Failed to fetch supported kinds from facilitator: ${error}`);
      }
    }

    if (this.supportedResponsesMap.size === 0) {
      throw lastError
        ? new Error(
            "Failed to initialize: no supported payment kinds loaded from any facilitator.",
            {
              cause: lastError,
            },
          )
        : new Error(
            "Failed to initialize: no supported payment kinds loaded from any facilitator.",
          );
    }

    this.validateFacilitatorCapabilities();
  }

  /**
   * Get supported kind for a specific version, network, and scheme
   *
   * @param x402Version - The x402 version
   * @param network - The network identifier
   * @param scheme - The payment scheme
   * @returns The supported kind or undefined if not found
   */
  getSupportedKind(
    x402Version: number,
    network: Network,
    scheme: string,
  ): SupportedKind | undefined {
    const versionMap = this.supportedResponsesMap.get(x402Version);
    if (!versionMap) return undefined;

    const supportedResponse = findByNetworkAndScheme(versionMap, scheme, network);
    if (!supportedResponse) return undefined;

    // Find the specific kind from the response (kinds are flat array with version in each element)
    return supportedResponse.kinds.find(
      kind =>
        kind.x402Version === x402Version && kind.network === network && kind.scheme === scheme,
    );
  }

  /**
   * Get facilitator extensions for a specific version, network, and scheme
   *
   * @param x402Version - The x402 version
   * @param network - The network identifier
   * @param scheme - The payment scheme
   * @returns The facilitator extensions or empty array if not found
   */
  getFacilitatorExtensions(x402Version: number, network: Network, scheme: string): string[] {
    const versionMap = this.supportedResponsesMap.get(x402Version);
    if (!versionMap) return [];

    const supportedResponse = findByNetworkAndScheme(versionMap, scheme, network);
    return supportedResponse?.extensions || [];
  }

  /**
   * Build payment requirements for a protected resource
   *
   * @param resourceConfig - Configuration for the protected resource
   * @returns Array of payment requirements
   */
  async buildPaymentRequirements(resourceConfig: ResourceConfig): Promise<PaymentRequirements[]> {
    const requirements: PaymentRequirements[] = [];

    // Find the matching server implementation
    const scheme = resourceConfig.scheme;
    const SchemeNetworkServer = findByNetworkAndScheme(
      this.registeredServerSchemes,
      scheme,
      resourceConfig.network,
    );

    if (!SchemeNetworkServer) {
      throw new Error(
        `No server implementation registered for ${scheme} on ${resourceConfig.network}. ` +
          `Make sure to call register() with a scheme server for this network.`,
      );
    }

    // Find the matching supported kind from facilitator
    const supportedKind = this.getSupportedKind(
      x402Version,
      resourceConfig.network,
      SchemeNetworkServer.scheme,
    );

    if (!supportedKind) {
      throw new Error(
        `Facilitator does not support ${SchemeNetworkServer.scheme} on ${resourceConfig.network}. ` +
          `Make sure to call initialize() to fetch supported kinds from facilitators.`,
      );
    }

    // Get facilitator extensions for this combination
    const facilitatorExtensions = this.getFacilitatorExtensions(
      x402Version,
      resourceConfig.network,
      SchemeNetworkServer.scheme,
    );

    // Parse the price using the scheme's price parser
    const parsedPrice = await SchemeNetworkServer.parsePrice(
      resourceConfig.price,
      resourceConfig.network,
    );

    // Build base payment requirements from resource config
    const baseRequirements: PaymentRequirements = {
      scheme: SchemeNetworkServer.scheme,
      network: resourceConfig.network,
      amount: parsedPrice.amount,
      asset: parsedPrice.asset,
      payTo: resourceConfig.payTo,
      maxTimeoutSeconds: resourceConfig.maxTimeoutSeconds || 300, // Default 5 minutes
      extra: {
        ...parsedPrice.extra,
        ...resourceConfig.extra, // Merge user-provided extra
      },
    };

    // Delegate to the implementation for scheme-specific enhancements
    const requirement = await SchemeNetworkServer.enhancePaymentRequirements(
      baseRequirements,
      supportedKind,
      facilitatorExtensions,
    );

    const resolved = resolvePaymentFlow(SchemeNetworkServer, requirement);
    requirement.extra = applyPaymentFlowWireExtra(requirement.extra ?? {}, resolved);

    requirements.push(requirement);
    return requirements;
  }

  /**
   * Build payment requirements from multiple payment options
   * This method handles resolving dynamic payTo/price functions and builds requirements for each option
   *
   * @param paymentOptions - Array of payment options to convert
   * @param context - HTTP request context for resolving dynamic functions
   * @returns Array of payment requirements (one per option)
   */
  async buildPaymentRequirementsFromOptions<TContext = unknown>(
    paymentOptions: Array<{
      scheme: string;
      payTo: string | ((context: TContext) => string | Promise<string>);
      price: Price | ((context: TContext) => Price | Promise<Price>);
      network: Network;
      maxTimeoutSeconds?: number;
      extra?: Record<string, unknown>;
    }>,
    context: TContext,
  ): Promise<PaymentRequirements[]> {
    const allRequirements: PaymentRequirements[] = [];

    for (const option of paymentOptions) {
      // Resolve dynamic payTo and price if they are functions
      const resolvedPayTo =
        typeof option.payTo === "function" ? await option.payTo(context) : option.payTo;
      const resolvedPrice =
        typeof option.price === "function" ? await option.price(context) : option.price;

      const resourceConfig: ResourceConfig = {
        scheme: option.scheme,
        payTo: resolvedPayTo,
        price: resolvedPrice,
        network: option.network,
        maxTimeoutSeconds: option.maxTimeoutSeconds,
        extra: option.extra,
      };

      // Use existing buildPaymentRequirements for each option
      const requirements = await this.buildPaymentRequirements(resourceConfig);
      allRequirements.push(...requirements);
    }

    return allRequirements;
  }

  /**
   * Create a payment required response
   *
   * @param requirements - Payment requirements
   * @param resourceInfo - Resource information
   * @param error - Error message
   * @param extensions - Optional declared extensions (for per-key enrichment)
   * @param transportContext - Optional transport-specific context (e.g., HTTP request, MCP tool context)
   * @param paymentPayload - Optional failed payment payload for response-time scheme enrichment
   * @returns Payment required response object
   */
  async createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    resourceInfo: ResourceInfo,
    error?: string,
    extensions?: Record<string, unknown>,
    transportContext?: unknown,
    paymentPayload?: PaymentPayload,
  ): Promise<PaymentRequired> {
    const acceptsClone = requirements.map(req => ({
      ...req,
      extra: structuredClone(req.extra),
    }));
    let workingAccepts = acceptsClone;
    let baselineAccepts = snapshotPaymentRequirementsList(workingAccepts);

    // V2 response with resource at top level
    let response: PaymentRequired = {
      x402Version: 2,
      error,
      resource: resourceInfo,
      accepts: workingAccepts,
    };

    // Add extensions if provided
    if (extensions && Object.keys(extensions).length > 0) {
      response.extensions = extensions;
    }

    for (let i = 0; i < workingAccepts.length; i++) {
      const accept = workingAccepts[i];
      const scheme = findByNetworkAndScheme(
        this.registeredServerSchemes,
        accept.scheme,
        accept.network as Network,
      );
      if (!scheme?.enrichPaymentRequiredResponse) {
        continue;
      }

      const context: SchemePaymentRequiredContext = {
        requirements: workingAccepts,
        paymentPayload,
        resourceInfo,
        error,
        paymentRequiredResponse: response,
        transportContext,
      };
      const enrichedAccepts = await scheme.enrichPaymentRequiredResponse(context);
      if (enrichedAccepts !== undefined) {
        workingAccepts = enrichedAccepts;
        response.accepts = workingAccepts;
      }
      assertAcceptsAdditiveExtraAfterSchemeEnrich(
        baselineAccepts,
        response.accepts,
        accept.scheme,
        accept.network,
      );
      baselineAccepts = snapshotPaymentRequirementsList(response.accepts);
    }

    // Let declared extensions add data to PaymentRequired response
    if (extensions) {
      for (const [key, declaration] of Object.entries(extensions)) {
        const extension = this.registeredExtensions.get(key);
        if (extension?.enrichPaymentRequiredResponse) {
          try {
            const context: PaymentRequiredContext = {
              requirements: workingAccepts,
              resourceInfo,
              error,
              paymentRequiredResponse: response,
              transportContext,
            };
            const extensionData = await extension.enrichPaymentRequiredResponse(
              declaration,
              context,
            );
            if (extensionData !== undefined) {
              if (!response.extensions) {
                response.extensions = {};
              }
              response.extensions[key] = extensionData;
            }
          } catch (error) {
            this.warnExtensionHookFailure(key, "enrichPaymentRequiredResponse", error);
          }
          assertAcceptsAllowlistedAfterExtensionEnrich(baselineAccepts, workingAccepts, key);
          baselineAccepts = snapshotPaymentRequirementsList(workingAccepts);
        }
      }
    }

    return response;
  }

  /**
   * Verifies a payment against requirements, running manual and in-use extension hooks.
   *
   * Resource-server `beforeVerify` hooks always run. Facilitator `/verify` runs only when
   * the scheme's payment flow has `verifyBeforeHandler` (the `authorization` flow). For
   * `upfront` / `escrow`, payment validity is established by settle; `afterVerify` /
   * `onVerifyFailure` still run when a `VerifyResponse` exists (facilitator result or a
   * beforeVerify skip).
   *
   * @param paymentPayload - Signed payment payload from the client
   * @param requirements - Requirements matched to the payload
   * @param declaredExtensions - Optional per-extension declarations for the request
   * @param transportContext - Optional transport-specific context (e.g. HTTP, MCP)
   * @returns Facilitator verify outcome (optionally carrying a `skipHandler` directive),
   *   or abort/recovery as driven by hooks
   */
  async verifyPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: unknown,
  ): Promise<ResourceVerifyRespone> {
    const resolvedDeclaredExtensions = declaredExtensions ?? {};
    const extensionKeysInUse = Object.keys(resolvedDeclaredExtensions);
    const matchedScheme = {
      network: requirements.network as Network,
      scheme: requirements.scheme,
    };

    const context: VerifyContext = {
      paymentPayload,
      requirements,
      declaredExtensions: resolvedDeclaredExtensions,
      transportContext,
    };

    for (const { label, hook } of this.getLabeledHooks(
      "beforeVerify",
      extensionKeysInUse,
      matchedScheme,
    )) {
      try {
        const result = await hook(context);
        if (result && "abort" in result && result.abort) {
          return {
            isValid: false,
            invalidReason: result.reason,
            invalidMessage: result.message,
          };
        }
        if (result && "skip" in result && result.skip) {
          return this.runAfterVerifyHooks(
            result.result,
            context,
            extensionKeysInUse,
            matchedScheme,
          );
        }
      } catch (error) {
        this.warnResourceServerHookFailure("beforeVerify", label, error);
      }
    }

    const { verifyBeforeHandler } = resolvePaymentFlowPhases(
      this.getPaymentFlow(paymentPayload, requirements),
    );
    if (!verifyBeforeHandler) {
      return { isValid: true };
    }

    try {
      // Find the facilitator that supports this payment type
      const facilitatorClient = this.getFacilitatorClient(
        paymentPayload.x402Version,
        requirements.network,
        requirements.scheme,
      );

      let verifyResult: VerifyResponse;

      if (!facilitatorClient) {
        // Fallback: try all facilitators if no specific support found
        let lastError: Error | undefined;

        for (const client of this.facilitatorClients) {
          try {
            verifyResult = await client.verify(paymentPayload, requirements);
            break;
          } catch (error) {
            lastError = error as Error;
          }
        }

        if (!verifyResult!) {
          throw (
            lastError ||
            new Error(
              `No facilitator supports ${requirements.scheme} on ${requirements.network} for v${paymentPayload.x402Version}`,
            )
          );
        }
      } else {
        // Use the specific facilitator that supports this payment
        verifyResult = await facilitatorClient.verify(paymentPayload, requirements);
      }

      return this.runAfterVerifyHooks(verifyResult, context, extensionKeysInUse, matchedScheme);
    } catch (error) {
      const failureContext: VerifyFailureContext = {
        ...context,
        error: error as Error,
      };

      for (const { label, hook } of this.getLabeledHooks(
        "onVerifyFailure",
        extensionKeysInUse,
        matchedScheme,
      )) {
        try {
          const result = await hook(failureContext);
          if (result && "recovered" in result && result.recovered) {
            return this.runAfterVerifyHooks(
              result.result,
              context,
              extensionKeysInUse,
              matchedScheme,
            );
          }
        } catch (error) {
          this.warnResourceServerHookFailure("onVerifyFailure", label, error);
        }
      }

      throw error;
    }
  }

  /**
   * Resolve the payment flow name for a payload/requirements pair from the
   * scheme's ATM-keyed {@link SchemeNetworkServer.paymentFlows} table.
   *
   * @param _payload - Client payment payload (unused; flow is requirements-driven)
   * @param requirements - Matched payment requirements
   * @returns Resolved payment flow name
   */
  getPaymentFlow(
    _payload: DeepReadonly<PaymentPayload>,
    requirements: DeepReadonly<PaymentRequirements>,
  ): PaymentFlowName {
    const scheme = findByNetworkAndScheme(
      this.registeredServerSchemes,
      requirements.scheme,
      requirements.network as Network,
    );
    if (!scheme) {
      throw new Error(
        `[x402] No server implementation registered for scheme: ${requirements.scheme}, network: ${requirements.network}`,
      );
    }
    return resolvePaymentFlow(scheme, requirements).paymentFlow;
  }

  /**
   * Create a failure-path cancel hook for a payment that passed pre-handler gates.
   *
   * @param paymentPayload - Signed payment payload from the client
   * @param requirements - Requirements matched to the payload
   * @param declaredExtensions - Optional per-extension declarations for the request
   * @param transportContext - Optional transport-specific context
   * @param settledPhases - Settle phases already completed before the handler (for settleOnCancel)
   * @returns Dispatcher with cancel only
   */
  createPaymentCancellationDispatcher(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: unknown,
    settledPhases: readonly SettlePhase[] = [],
  ): PaymentCancellationDispatcher {
    const resolvedDeclaredExtensions = declaredExtensions ?? {};
    const resolvedSettledPhases = settledPhases;
    let cancelPromise: Promise<SettleResponse | void> | undefined;

    return {
      cancel: (options: VerifiedPaymentCancelOptions) => {
        if (!cancelPromise) {
          cancelPromise = this.dispatchVerifiedPaymentCanceled(
            paymentPayload,
            requirements,
            resolvedDeclaredExtensions,
            options,
            transportContext,
            resolvedSettledPhases,
          );
        }
        return cancelPromise;
      },
    };
  }

  /**
   * Settle a verified payment
   *
   * @param paymentPayload - The payment payload to settle
   * @param requirements - The payment requirements
   * @param declaredExtensions - Optional declared extensions (for per-key enrichment)
   * @param transportContext - Optional transport-specific context (e.g., HTTP request/response, MCP tool context)
   * @param settlementOverrides - Optional overrides for settlement parameters (e.g., partial settlement amount)
   * @param phase - Which settle invocation this is (defaults to `after-handler`)
   * @returns Settlement response
   */
  async settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: unknown,
    settlementOverrides?: SettlementOverrides,
    phase: SettlePhase = "after-handler",
  ): Promise<SettleResponse> {
    const resolvedDeclaredExtensions = declaredExtensions ?? {};
    const extensionKeysInUse = Object.keys(resolvedDeclaredExtensions);

    // Apply settlement overrides (e.g., partial settlement for upto scheme)
    let effectiveRequirements = requirements;
    if (settlementOverrides?.amount !== undefined) {
      // Only `$…` overrides need asset decimals. Atomic and percent formats must
      // not force a decimals lookup (unknown custom mints would otherwise fail).
      let decimals: number | undefined;
      if (/^\$\d+(?:\.\d+)?$/.test(settlementOverrides.amount)) {
        const scheme = findByNetworkAndScheme(
          this.registeredServerSchemes,
          requirements.scheme,
          requirements.network as Network,
        );
        decimals = scheme?.getAssetDecimals?.(
          requirements.asset ?? "",
          requirements.network as Network,
        );
      }
      effectiveRequirements = {
        ...requirements,
        amount: resolveSettlementOverrideAmount(settlementOverrides.amount, requirements, decimals),
      };
    }

    const context: SettleContext = {
      paymentPayload,
      requirements: effectiveRequirements,
      declaredExtensions: resolvedDeclaredExtensions,
      phase,
      transportContext,
    };
    const matchedScheme = {
      network: effectiveRequirements.network as Network,
      scheme: effectiveRequirements.scheme,
    };

    for (const { label, hook } of this.getLabeledHooks(
      "beforeSettle",
      extensionKeysInUse,
      matchedScheme,
    )) {
      try {
        const result = await hook(context);
        if (result && "abort" in result && result.abort) {
          throw new SettleError(400, {
            success: false,
            errorReason: result.reason,
            errorMessage: result.message,
            transaction: "",
            network: requirements.network,
          });
        }
        if (result && "skip" in result && result.skip) {
          const settleResult = result.result;
          const skipResultContext: SettleResultContext = {
            ...context,
            result: settleResult,
            transportContext,
          };
          for (const { label, hook } of this.getLabeledHooks(
            "afterSettle",
            extensionKeysInUse,
            matchedScheme,
          )) {
            try {
              await hook(skipResultContext);
            } catch (error) {
              this.warnResourceServerHookFailure("afterSettle", label, error);
            }
          }
          await this.enrichSettlementResponse(
            settleResult,
            skipResultContext,
            resolvedDeclaredExtensions,
            matchedScheme,
          );
          return settleResult;
        }
      } catch (error) {
        if (error instanceof SettleError) {
          throw error;
        }
        this.warnResourceServerHookFailure("beforeSettle", label, error);
      }
    }

    try {
      const scheme = findByNetworkAndScheme(
        this.registeredServerSchemes,
        matchedScheme.scheme,
        matchedScheme.network,
      );
      // Settle-local payload copy so a second settle can enrich the same keys
      // without mutating the caller's object (assertAdditivePayloadEnrichment
      // still runs against the original client payload).
      let settlePayload: PaymentPayload = paymentPayload;
      const payloadEnrichmentHook = scheme?.enrichSettlementPayload;
      if (payloadEnrichmentHook) {
        const label = `scheme "${matchedScheme.scheme}" enrichSettlementPayload`;
        const enrichment = await payloadEnrichmentHook(context);
        if (enrichment !== undefined) {
          assertAdditivePayloadEnrichment(paymentPayload.payload, enrichment, label);
          settlePayload = {
            ...paymentPayload,
            payload: { ...paymentPayload.payload, ...enrichment },
          };
        }
      }

      // Find the facilitator that supports this payment type
      const facilitatorClient = this.getFacilitatorClient(
        settlePayload.x402Version,
        effectiveRequirements.network,
        effectiveRequirements.scheme,
      );

      let settleResult: SettleResponse;

      if (!facilitatorClient) {
        // Fallback: try all facilitators if no specific support found
        let lastError: Error | undefined;

        for (const client of this.facilitatorClients) {
          try {
            settleResult = await this.settleWithPendingRetry(
              client,
              settlePayload,
              effectiveRequirements,
            );
            break;
          } catch (error) {
            lastError = error as Error;
          }
        }

        if (!settleResult!) {
          throw (
            lastError ||
            new Error(
              `No facilitator supports ${effectiveRequirements.scheme} on ${effectiveRequirements.network} for v${settlePayload.x402Version}`,
            )
          );
        }
      } else {
        // Use the specific facilitator that supports this payment
        settleResult = await this.settleWithPendingRetry(
          facilitatorClient,
          settlePayload,
          effectiveRequirements,
        );
      }

      // A returned (non-thrown) settleResult with success:false — e.g. from a
      // remote/HTTP facilitator, or a settlement_pending outcome that
      // survived the single automatic retry above — previously looked like a
      // success: afterSettle hooks would run and callers would treat the
      // response as settled. Route it through onSettleFailure like a thrown
      // error so hooks get a chance to recover.
      if (!settleResult.success) {
        const failureContext: SettleFailureContext = {
          ...context,
          error: settleResponseToError(settleResult),
        };

        for (const { label, hook } of this.getLabeledHooks(
          "onSettleFailure",
          extensionKeysInUse,
          matchedScheme,
        )) {
          try {
            const result = await hook(failureContext);
            if (result && "recovered" in result && result.recovered) {
              return result.result;
            }
          } catch (error) {
            this.warnResourceServerHookFailure("onSettleFailure", label, error);
          }
        }

        return settleResult;
      }

      // Execute afterSettle hooks
      const resultContext: SettleResultContext = {
        ...context,
        result: settleResult,
      };

      for (const { label, hook } of this.getLabeledHooks(
        "afterSettle",
        extensionKeysInUse,
        matchedScheme,
      )) {
        try {
          await hook(resultContext);
        } catch (error) {
          this.warnResourceServerHookFailure("afterSettle", label, error);
        }
      }

      await this.enrichSettlementResponse(
        settleResult,
        resultContext,
        resolvedDeclaredExtensions,
        matchedScheme,
      );

      return settleResult;
    } catch (error) {
      const failureContext: SettleFailureContext = {
        ...context,
        error: error as Error,
      };

      for (const { label, hook } of this.getLabeledHooks(
        "onSettleFailure",
        extensionKeysInUse,
        matchedScheme,
      )) {
        try {
          const result = await hook(failureContext);
          if (result && "recovered" in result && result.recovered) {
            return result.result;
          }
        } catch (error) {
          this.warnResourceServerHookFailure("onSettleFailure", label, error);
        }
      }

      throw error;
    }
  }

  /**
   * Find matching payment requirements for a payment
   *
   * @param availableRequirements - Array of available payment requirements
   * @param paymentPayload - The payment payload
   * @returns Matching payment requirements or undefined
   */
  /**
   * Validates optional client extension echoes against server-advertised extension info.
   * When the client omits extensions entirely, validation passes.
   *
   * @param paymentRequired - Server payment required response used for matching
   * @param paymentPayload - Client payment payload
   * @returns Whether echoed extension info preserves server-advertised values
   */
  validateExtensions(
    paymentRequired: PaymentRequired,
    paymentPayload: PaymentPayload,
  ): ExtensionValidationResult {
    if (paymentPayload.x402Version !== 2) {
      return { valid: true };
    }

    const serverExtensions = paymentRequired.extensions;
    const clientExtensions = paymentPayload.extensions;
    if (!clientExtensions || Object.keys(clientExtensions).length === 0) {
      return { valid: true };
    }

    for (const [key, echoedValue] of Object.entries(clientExtensions)) {
      const advertisedInfo = getExtensionInfo(serverExtensions?.[key]);
      const echoedInfo = getExtensionInfo(echoedValue);

      if (serverExtensions && Object.prototype.hasOwnProperty.call(serverExtensions, key)) {
        const dynamicFields = this.registeredExtensions.get(key)?.dynamicInfoFields;
        const additiveFields = ADDITIVE_ARRAY_INFO_FIELDS[key];
        const maxLengths = ADDITIVE_ARRAY_MAX_LENGTHS[key];
        if (
          !extensionInfoMatchesAdvertised(
            omitFields(advertisedInfo, dynamicFields),
            omitFields(echoedInfo, dynamicFields),
            additiveFields,
            maxLengths,
          )
        ) {
          return {
            valid: false,
            invalidReason: "extension_echo_mismatch",
            extensionKey: key,
          };
        }
      }

      const serverOwnedFields = SERVER_OWNED_INFO_FIELDS[key];
      if (
        serverOwnedFields &&
        !serverOwnedInfoFieldsMatch(advertisedInfo, echoedInfo, serverOwnedFields)
      ) {
        return {
          valid: false,
          invalidReason: "extension_echo_mismatch",
          extensionKey: key,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Finds the server-advertised requirement that matches a client payment payload.
   *
   * @param availableRequirements - Payment requirements advertised for the resource.
   * @param paymentPayload - Signed payment payload from the client.
   * @returns The matching requirement, or undefined when none match.
   */
  findMatchingRequirements(
    availableRequirements: PaymentRequirements[],
    paymentPayload: PaymentPayload,
  ): PaymentRequirements | undefined {
    switch (paymentPayload.x402Version) {
      case 2:
        if (!paymentPayload.accepted) {
          return undefined;
        }

        // For v2, all server-declared requirements must match.
        // The client may include additive scheme-specific metadata under `accepted.extra`.
        // Scheme-declared dynamicExtraFields are omitted from the extra comparison
        return availableRequirements.find(paymentRequirements => {
          const scheme = findByNetworkAndScheme(
            this.registeredServerSchemes,
            paymentRequirements.scheme,
            paymentRequirements.network,
          );
          return paymentRequirementsMatchAccepted(
            paymentRequirements,
            paymentPayload.accepted,
            scheme?.dynamicExtraFields,
          );
        });
      case 1:
        if (!paymentPayload.accepted) {
          return undefined;
        }

        // For v1, match by scheme and network
        return availableRequirements.find(
          req =>
            req.scheme === paymentPayload.accepted.scheme &&
            req.network === paymentPayload.accepted.network,
        );
      default:
        throw new Error(
          `Unsupported x402 version: ${(paymentPayload as PaymentPayload).x402Version}`,
        );
    }
  }

  /**
   * Calls `facilitatorClient.settle` once, then retries exactly once with the
   * identical payload/requirements when the outcome is a non-terminal
   * `settlement_pending` failure carrying a broadcast transaction hash. Sits
   * above all scheme/network dispatch — the mechanism that actually handles
   * the retry (via its own `PendingSettlementStore` check) reconciles against
   * the already-broadcast transaction instead of verifying and broadcasting
   * a second one. No mutation, backoff, or sleep: the mechanism layer owns
   * any bounded waiting. Any other outcome (success, or a different failure
   * reason) short-circuits after the first call. Capped at exactly one retry
   * regardless of the second outcome, so this can never loop. Mirrors Go's
   * `settleWithPendingRetry` (`go/server.go`).
   *
   * @param facilitatorClient - The facilitator client to call
   * @param settlePayload - The (possibly enriched) settle-local payload
   * @param effectiveRequirements - The effective payment requirements
   * @returns The settle result, either from the first attempt or the single retry
   */
  private async settleWithPendingRetry(
    facilitatorClient: FacilitatorClient,
    settlePayload: PaymentPayload,
    effectiveRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    let result: SettleResponse | undefined;
    let retryable: boolean;
    try {
      result = await facilitatorClient.settle(settlePayload, effectiveRequirements);
      retryable = isRetryableSettlementPendingResult(result);
    } catch (error) {
      if (!isRetryableSettlementPendingError(error)) {
        throw error;
      }
      retryable = true;
    }

    if (!retryable) {
      return result!;
    }
    return facilitatorClient.settle(settlePayload, effectiveRequirements);
  }

  /**
   * Validates that each registered scheme's configuration is compatible with the
   * facilitator capabilities advertised for the scheme/network combinations it
   * supports. Only schemes the facilitator actually supports are validated.
   *
   * @throws Error listing every capability problem when one or more schemes report one.
   */
  private validateFacilitatorCapabilities(): void {
    const configErrors: string[] = [];

    for (const [network, schemeMap] of this.registeredServerSchemes) {
      for (const [scheme, server] of schemeMap) {
        if (!server.validateFacilitatorSupport) continue;

        for (const x402Version of this.supportedResponsesMap.keys()) {
          const supportedKind = this.getSupportedKind(x402Version, network as Network, scheme);
          if (!supportedKind) continue;

          const extensions = this.getFacilitatorExtensions(x402Version, network as Network, scheme);
          const problem = server.validateFacilitatorSupport(
            network as Network,
            supportedKind,
            extensions,
          );
          if (problem) configErrors.push(`${scheme} on ${network}: ${problem}`);
        }
      }
    }

    if (configErrors.length > 0) {
      throw new FacilitatorCapabilityError(configErrors);
    }
  }

  /**
   * Logs a warning when a manual or extension adapter lifecycle hook throws.
   *
   * @param phase - Lifecycle phase name (e.g. `beforeVerify`)
   * @param label - Hook source label from {@link getLabeledHooks} (manual index or extension key)
   * @param error - Thrown value or rejection reason
   */
  private warnResourceServerHookFailure(phase: string, label: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[x402] Resource server ${phase} hook threw (${label}): ${detail}`);
  }

  /**
   * Logs a warning when a registered extension enrichment hook throws.
   *
   * @param extensionKey - Registered extension identifier
   * @param hookName - Hook method name (e.g. `enrichDeclaration`)
   * @param error - Thrown value or rejection reason
   */
  private warnExtensionHookFailure(extensionKey: string, hookName: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[x402] extension "${extensionKey}" ${hookName} threw: ${detail}`);
  }

  /**
   * Executes after-verify hooks for facilitator and hook-provided verify results.
   *
   * @param verifyResult - Verify response passed to after-verify hooks.
   * @param context - Verify context shared with before-verify hooks.
   * @param extensionKeysInUse - Declared extension keys for this request.
   * @param matchedScheme - Scheme/network selected for this payment.
   * @param matchedScheme.network - Matched payment network.
   * @param matchedScheme.scheme - Matched payment scheme.
   * @returns Verify response with any in-process skip handler directive.
   */
  private async runAfterVerifyHooks(
    verifyResult: VerifyResponse,
    context: VerifyContext,
    extensionKeysInUse: readonly string[],
    matchedScheme: { network: Network; scheme: string },
  ): Promise<ResourceVerifyRespone> {
    const resultContext: VerifyResultContext = {
      ...context,
      result: verifyResult,
    };

    let skipHandler: SkipHandlerDirective | undefined;
    for (const { label, hook } of this.getLabeledHooks(
      "afterVerify",
      extensionKeysInUse,
      matchedScheme,
    )) {
      try {
        const directive = await hook(resultContext);
        if (directive && "abort" in directive && directive.abort) {
          await this.dispatchVerifiedPaymentCanceled(
            context.paymentPayload,
            context.requirements,
            context.declaredExtensions,
            { reason: "after_verify_aborted" },
            context.transportContext,
            [],
          );
          return {
            isValid: false,
            invalidReason: directive.reason,
            invalidMessage: directive.message,
          };
        }
        if (directive && "skipHandler" in directive && directive.skipHandler) {
          skipHandler = directive.response ?? {};
        }
      } catch (error) {
        this.warnResourceServerHookFailure("afterVerify", label, error);
      }
    }

    return skipHandler ? { ...verifyResult, skipHandler } : verifyResult;
  }

  /**
   * Runs response enrichment after settlement lifecycle hooks complete.
   *
   * @param settleResult - Mutable settlement result being returned to the caller
   * @param context - Read-only hook context for enrichment callbacks
   * @param declaredExtensions - Extension declarations present on this payment
   * @param matchedScheme - Scheme/network selected for this settlement
   * @param matchedScheme.network - Matched payment network
   * @param matchedScheme.scheme - Matched payment scheme
   */
  private async enrichSettlementResponse(
    settleResult: SettleResponse,
    context: SettleResultContext,
    declaredExtensions: Record<string, unknown>,
    matchedScheme: { network: Network; scheme: string },
  ): Promise<void> {
    if (Object.keys(declaredExtensions).length > 0) {
      const settleCoreSnapshot = snapshotSettleResponseCore(settleResult);
      for (const [key, declaration] of Object.entries(declaredExtensions)) {
        const extension = this.registeredExtensions.get(key);
        if (!extension?.enrichSettlementResponse) continue;

        try {
          const extensionData = await extension.enrichSettlementResponse(declaration, context);
          if (extensionData !== undefined) {
            if (!settleResult.extensions) {
              settleResult.extensions = {};
            }
            settleResult.extensions[key] = extensionData;
          }
        } catch (error) {
          this.warnExtensionHookFailure(key, "enrichSettlementResponse", error);
        }
        assertSettleResponseCoreUnchanged(settleCoreSnapshot, settleResult, key);
      }
    }

    const scheme = findByNetworkAndScheme(
      this.registeredServerSchemes,
      matchedScheme.scheme,
      matchedScheme.network,
    );
    const hook = scheme?.enrichSettlementResponse;
    if (!hook) return;

    const label = `scheme "${matchedScheme.scheme}" enrichSettlementResponse`;
    try {
      const enrichment = await hook(context);
      if (enrichment === undefined) return;

      assertAdditiveSettlementExtra(settleResult.extra ?? {}, enrichment, label);
      settleResult.extra = mergeAdditiveSettlementExtra(settleResult.extra ?? {}, enrichment);
    } catch (error) {
      this.warnResourceServerHookFailure("enrichSettlementResponse", label, error);
    }
  }

  /**
   * Notify hooks that verified work ended before settlement.
   * After cleanup hooks, asks the matched scheme for {@link SchemeNetworkServer.settleOnCancel}
   * requirements and settles once when provided. Settlement errors are warned, not thrown,
   * so transports can preserve the original application failure.
   *
   * @param paymentPayload - Signed payment payload from the client
   * @param requirements - Requirements matched to the payload
   * @param declaredExtensions - Optional per-extension declarations for the request
   * @param options - Cancellation reason and optional diagnostics
   * @param fallbackTransportContext - Optional transport-specific context
   * @param settledPhases - Settle phases that already completed for this payment
   * @returns Cancel settle response when the scheme provides settleOnCancel requirements, otherwise undefined
   */
  private async dispatchVerifiedPaymentCanceled(
    paymentPayload: DeepReadonly<PaymentPayload>,
    requirements: DeepReadonly<PaymentRequirements>,
    declaredExtensions: DeepReadonly<Record<string, unknown>>,
    options: VerifiedPaymentCancelOptions,
    fallbackTransportContext?: unknown,
    settledPhases: readonly SettlePhase[] = [],
  ): Promise<SettleResponse | void> {
    const extensionKeysInUse = Object.keys(declaredExtensions);
    const matchedScheme = {
      network: requirements.network as Network,
      scheme: requirements.scheme,
    };
    const context: VerifiedPaymentCanceledContext = {
      paymentPayload,
      requirements,
      declaredExtensions,
      phase: "cancel",
      transportContext: fallbackTransportContext,
      reason: options.reason,
      error: options.error,
      responseStatus: options.responseStatus,
      settledPhases,
    };

    for (const { label, hook } of this.getLabeledHooks(
      "onVerifiedPaymentCanceled",
      extensionKeysInUse,
      matchedScheme,
    )) {
      try {
        await hook(context);
      } catch (error) {
        this.warnResourceServerHookFailure("onVerifiedPaymentCanceled", label, error);
      }
    }

    const scheme = findByNetworkAndScheme(
      this.registeredServerSchemes,
      matchedScheme.scheme,
      matchedScheme.network,
    );
    if (!scheme?.settleOnCancel || !settledPhases.includes("before-handler")) {
      return;
    }

    const label = `scheme "${matchedScheme.scheme}" settleOnCancel`;
    try {
      const cancelRequirements = await scheme.settleOnCancel(context);
      if (!cancelRequirements) {
        return;
      }
      return await this.settlePayment(
        paymentPayload as PaymentPayload,
        cancelRequirements,
        declaredExtensions as Record<string, unknown>,
        fallbackTransportContext,
        undefined,
        "cancel",
      );
    } catch (error) {
      this.warnResourceServerHookFailure("settleOnCancel", label, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        errorReason:
          error instanceof SettleError ? (error.errorReason ?? errorMessage) : errorMessage,
        errorMessage: error instanceof SettleError ? error.errorMessage : undefined,
        transaction: "",
        network: requirements.network as Network,
      };
    }
  }

  /**
   * Manual hooks first, then the matched scheme adapter, then extension adapters for keys in use.
   * Each entry carries a stable label for logging when a hook throws.
   *
   * @param phase - Hook slot (e.g. `beforeVerify`)
   * @param extensionKeysInUse - Declared extension keys for this request
   * @param matchedScheme - Scheme/network selected for this payment
   * @param matchedScheme.network - Matched payment network
   * @param matchedScheme.scheme - Matched payment scheme
   * @returns Hooks in invocation order with source labels
   */
  private getLabeledHooks<P extends ResourceServerHookPhase>(
    phase: P,
    extensionKeysInUse: readonly string[],
    matchedScheme?: { network: Network; scheme: string },
  ): Array<{
    label: string;
    hook: NonNullable<ExtensionAdapterHandles[P]>;
  }> {
    type HookFn = NonNullable<ExtensionAdapterHandles[P]>;
    const manualKey = `${phase}Hooks` as ResourceServerManualHookArrayKey;
    const manual = (this as Record<ResourceServerManualHookArrayKey, HookFn[]>)[manualKey];

    const out: Array<{ label: string; hook: HookFn }> = [];
    manual.forEach((hook, index) => {
      out.push({ label: `manual ${phase} hook #${index}`, hook });
    });

    if (matchedScheme) {
      const schemeHandles = findByNetworkAndScheme(
        this.schemeHookAdapters,
        matchedScheme.scheme,
        matchedScheme.network,
      );
      const hook = schemeHandles?.[phase];
      if (hook !== undefined) {
        out.push({
          label: `scheme "${matchedScheme.scheme}" ${phase}`,
          hook,
        });
      }
    }

    const inUse = new Set(extensionKeysInUse);
    for (const [extensionKey, adapterHandles] of this.extensionHookAdapters.entries()) {
      if (!inUse.has(extensionKey)) continue;
      const hook = adapterHandles[phase];
      if (hook !== undefined) {
        out.push({ label: `extension "${extensionKey}" ${phase}`, hook });
      }
    }

    return out;
  }

  /**
   * Get facilitator client for a specific version, network, and scheme
   *
   * @param x402Version - The x402 version
   * @param network - The network identifier
   * @param scheme - The payment scheme
   * @returns The facilitator client or undefined if not found
   */
  private getFacilitatorClient(
    x402Version: number,
    network: Network,
    scheme: string,
  ): FacilitatorClient | undefined {
    const versionMap = this.facilitatorClientsMap.get(x402Version);
    if (!versionMap) return undefined;

    // Use findByNetworkAndScheme for pattern matching
    return findByNetworkAndScheme(versionMap, scheme, network);
  }
}

/**
 * Normalizes an extension declaration or echo to its comparable `info` payload.
 *
 * @param value - Extension value that may wrap its payload under `info`.
 * @returns The nested `info` value when present; otherwise `value` unchanged.
 */
function getExtensionInfo(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "info")
  ) {
    return (value as Record<string, unknown>).info;
  }
  return value;
}

/**
 * Returns whether client-echoed server-owned fields match the server advertisement.
 * When the server did not declare the extension, `advertised` is treated as empty
 * so clients cannot invent fields such as builder-code `a`.
 *
 * @param advertised - Extension info advertised by the server, if any.
 * @param echoed - Extension info echoed back by the client.
 * @param serverOwnedFields - Field names the client must not invent.
 * @returns True when every echoed server-owned field matches the advertisement.
 */
function serverOwnedInfoFieldsMatch(
  advertised: unknown,
  echoed: unknown,
  serverOwnedFields: ReadonlySet<string>,
): boolean {
  if (echoed === null || typeof echoed !== "object" || Array.isArray(echoed)) {
    return true;
  }

  const echoedRecord = echoed as Record<string, unknown>;
  const advertisedRecord =
    advertised !== null && typeof advertised === "object" && !Array.isArray(advertised)
      ? (advertised as Record<string, unknown>)
      : {};

  for (const field of serverOwnedFields) {
    if (!Object.prototype.hasOwnProperty.call(echoedRecord, field)) {
      continue;
    }
    const echoedValue = echoedRecord[field];
    if (echoedValue === undefined) {
      continue;
    }
    if (
      !Object.prototype.hasOwnProperty.call(advertisedRecord, field) ||
      !deepEqual(advertisedRecord[field], echoedValue)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Returns a copy of an object without the named dynamic fields.
 *
 * @param value - Object to filter (extension info or payment-requirements extra).
 * @param fields - Field names regenerated per response that must not be compared.
 * @returns The value unchanged when no fields apply; otherwise a copy without them.
 */
function omitFields(value: unknown, fields?: string[]): unknown {
  if (!fields || fields.length === 0) {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const copy = { ...(value as Record<string, unknown>) };
  for (const field of fields) {
    delete copy[field];
  }
  return copy;
}

/**
 * Returns whether a client-echoed extension payload preserves the server advertisement.
 * Fields listed in `additiveFields` (e.g. builder-code `s`) allow the echo to add array
 * entries; every other array field must match exactly via `deepEqual`, same as the
 * exact-match arrays required when matching a client's selected `extra` fields.
 *
 * @param advertised - Extension info advertised by the server.
 * @param echoed - Extension info echoed back by the client.
 * @param additiveFields - Field names whose array values may be extended by the echo.
 * @param maxLengths - Combined-length caps for additive fields, keyed by field name.
 * @returns True when `echoed` contains every field from `advertised`.
 */
function extensionInfoMatchesAdvertised(
  advertised: unknown,
  echoed: unknown,
  additiveFields?: ReadonlySet<string>,
  maxLengths?: Record<string, number>,
): boolean {
  return objectContainsSubset(advertised, echoed, additiveFields, maxLengths);
}

/**
 * Reports whether a returned (non-thrown) settle outcome is a retryable
 * `settlement_pending`: `success: false`, `errorReason === "settlement_pending"`,
 * and a non-empty `transaction` hash. Mirrors Go's `isRetryableSettlementPending`
 * (`go/server.go`) for the HTTP/remote `FacilitatorClient` path.
 *
 * @param result - The settle response to inspect
 * @returns Whether the result is a retryable settlement_pending outcome
 */
function isRetryableSettlementPendingResult(result: SettleResponse): boolean {
  return (
    !result.success && result.errorReason === SETTLEMENT_PENDING_REASON && !!result.transaction
  );
}

/**
 * Reports whether a thrown settle outcome is a retryable `settlement_pending`:
 * a {@link SettleError} with `errorReason === "settlement_pending"` and a
 * non-empty `transaction` hash. Mirrors Go's `isRetryableSettlementPending`
 * (`go/server.go`) for the local/in-process `FacilitatorClient` path, where a
 * business-logic settlement_pending failure is thrown rather than returned.
 *
 * @param error - The thrown value to inspect
 * @returns Whether the error is a retryable settlement_pending outcome
 */
function isRetryableSettlementPendingError(error: unknown): boolean {
  return (
    error instanceof SettleError &&
    error.errorReason === SETTLEMENT_PENDING_REASON &&
    !!error.transaction
  );
}

/**
 * Synthesizes an {@link Error} from a returned `success: false`
 * {@link SettleResponse} so it can flow through the same
 * {@link SettleFailureContext} / {@link OnSettleFailureHook} path as a thrown
 * error. Mirrors Go's `settleResponseToError` (`go/server.go`) and Python's
 * `Exception(settle_result.error_reason or "Settlement failed")` fallback
 * (`python/x402/server_base.py`).
 *
 * @param result - The failed settle response
 * @returns A {@link SettleError} carrying the response's failure details
 */
function settleResponseToError(result: SettleResponse): SettleError {
  const reason = result.errorReason || "Settlement failed";
  return new SettleError(500, { ...result, errorReason: reason });
}

/**
 * Returns whether a client-selected requirement satisfies a server-advertised requirement.
 *
 * Core payment terms and all server-declared `extra` fields must match exactly,
 * but clients may include additive scheme-specific metadata under `accepted.extra`.
 * Fields listed in `dynamicExtraFields` are excluded from the extra comparison.
 *
 * @param required - Server-advertised payment requirement.
 * @param accepted - Client-selected payment requirement from the payment payload.
 * @param dynamicExtraFields - Scheme-declared `extra` keys regenerated per PaymentRequired.
 * @returns True when `accepted` preserves every server-declared requirement.
 */
function paymentRequirementsMatchAccepted(
  required: PaymentRequirements,
  accepted: PaymentRequirements,
  dynamicExtraFields?: string[],
): boolean {
  const { extra: requiredExtra, ...requiredCore } = required;
  const { extra: acceptedExtra, ...acceptedCore } = accepted;

  if (!deepEqual(requiredCore, acceptedCore)) {
    return false;
  }

  if (requiredExtra === undefined) {
    return true;
  }

  return objectContainsSubset(
    omitFields(requiredExtra, dynamicExtraFields),
    omitFields(acceptedExtra, dynamicExtraFields),
  );
}

/**
 * Recursively checks that `actual` contains every field and value from `expected`.
 * Object values may contain additional fields. Primitives must match exactly.
 *
 * When the current field's name is in `additiveFields` (e.g. builder-code `s`) and
 * either side is an array, the array is additive: every element of `expected` must
 * appear in `actual` (extra elements allowed), and a bare scalar on either side is
 * treated as a single-element array so it compares against an array on the other
 * side. When `fieldKey` also has an entry in `maxLengths`, `actual` is rejected
 * outright if it exceeds that combined length, rather than being accepted and
 * silently truncated downstream. Every other array field - including
 * payment-requirements `extra` matching, which never passes `additiveFields` - must
 * match exactly via `deepEqual`, same as any other primitive.
 *
 * @param expected - Required subset.
 * @param actual - Candidate object.
 * @param additiveFields - Field names whose array values may be extended by `actual`.
 * @param maxLengths - Combined-length caps for additive fields, keyed by field name.
 * @param fieldKey - Name of the field being compared at this recursion level, used to
 *   test membership in `additiveFields`; undefined at the root call.
 * @returns True when `actual` contains `expected`.
 */
function objectContainsSubset(
  expected: unknown,
  actual: unknown,
  additiveFields?: ReadonlySet<string>,
  maxLengths?: Record<string, number>,
  fieldKey?: string,
): boolean {
  if (
    fieldKey !== undefined &&
    additiveFields?.has(fieldKey) &&
    (Array.isArray(expected) || Array.isArray(actual))
  ) {
    const expectedArray = toComparableArray(expected);
    const actualArray = toComparableArray(actual);
    if (!expectedArray || !actualArray) {
      return false;
    }
    const maxLength = maxLengths?.[fieldKey];
    if (maxLength !== undefined && actualArray.length > maxLength) {
      return false;
    }
    return expectedArray.every(expItem => actualArray.some(actItem => deepEqual(expItem, actItem)));
  }

  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    return deepEqual(expected, actual);
  }

  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }

  const actualRecord = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every(([key, value]) => {
    const hasActualKey = Object.prototype.hasOwnProperty.call(actualRecord, key);
    if (!hasActualKey) {
      return value === undefined;
    }
    return objectContainsSubset(value, actualRecord[key], additiveFields, maxLengths, key);
  });
}

export default x402ResourceServer;
