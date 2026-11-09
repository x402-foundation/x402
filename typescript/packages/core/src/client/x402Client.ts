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
    const clientSchemesByNetwork = this.registeredClientSchemes.get(paymentRequired.x402Version);
    if (!clientSchemesByNetwork) {
      throw new Error(`No client registered for x402 version: ${paymentRequired.x402Version}`);
    }

    const requirements = this.selectPaymentRequirements(paymentRequired.x402Version, paymentRequired.accepts);

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
   * @returns The selected payment requirements
   */
  private selectPaymentRequirements(x402Version: number, paymentRequirements: PaymentRequirements[]): PaymentRequirements {
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
   * @returns Requirements that pass spend controls
   */
  private applySpendControls(
    x402Version: number,
    requirements: PaymentRequirements[],
    clientSchemesByNetwork: Map<string, Map<string, SchemeNetworkClient>>,
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

    return filtered;
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
