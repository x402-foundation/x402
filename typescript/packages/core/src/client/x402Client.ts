import { x402Version } from "..";
import { SchemeNetworkClient } from "../types/mechanisms";
import { PaymentPayload, PaymentRequirements } from "../types/payments";
import { Network, PaymentRequired, SettleResponse } from "../types";
import { findByNetworkAndScheme, findSchemesByNetwork } from "../utils";

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
   * Called after payload creation when the extension key is present in
   * paymentRequired.extensions. Allows the extension to enrich the payload
   * with extension-specific data (e.g., signing an EIP-2612 permit).
   *
   * @param paymentPayload - The payment payload to enrich
   * @param paymentRequired - The original PaymentRequired response
   * @returns The enriched payment payload
   */
  enrichPaymentPayload?: (
    paymentPayload: PaymentPayload,
    paymentRequired: PaymentRequired,
  ) => Promise<PaymentPayload>;
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
   * Registers a client extension that can enrich payment payloads.
   *
   * Extensions are invoked after the scheme creates the base payload and the
   * payload is wrapped with extensions/resource/accepted data. If the extension's
   * key is present in `paymentRequired.extensions`, the extension's
   * `enrichPaymentPayload` hook is called to modify the payload.
   *
   * @param extension - The client extension to register
   * @returns The x402Client instance for chaining
   */
  registerExtension(extension: ClientExtension): x402Client {
    this.registeredExtensions.set(extension.key, extension);
    return this;
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
        { extensions: paymentRequired.extensions },
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
   * Merges server-declared extensions with scheme-provided extensions.
   * Scheme extensions overlay on top of server extensions at each key,
   * preserving server-provided schema while overlaying scheme-provided info.
   *
   * @param serverExtensions - Extensions declared by the server in the 402 response
   * @param schemeExtensions - Extensions provided by the scheme client (e.g. EIP-2612)
   * @returns The merged extensions object, or undefined if both inputs are undefined
   */
  private mergeExtensions(
    serverExtensions?: Record<string, unknown>,
    schemeExtensions?: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    if (!schemeExtensions) return serverExtensions;
    if (!serverExtensions) return schemeExtensions;

    const merged = { ...serverExtensions };
    for (const [key, schemeValue] of Object.entries(schemeExtensions)) {
      const serverValue = merged[key];
      if (
        serverValue &&
        typeof serverValue === "object" &&
        schemeValue &&
        typeof schemeValue === "object"
      ) {
        // Deep merge: scheme info overlays server info, schema preserved
        merged[key] = { ...serverValue as Record<string, unknown>, ...schemeValue as Record<string, unknown> };
      } else {
        merged[key] = schemeValue;
      }
    }
    return merged;
  }

  /**
   * Enriches a payment payload by calling registered extension hooks.
   * For each extension key present in the PaymentRequired response,
   * invokes the corresponding extension's enrichPaymentPayload callback.
   *
   * @param paymentPayload - The payment payload to enrich with extension data
   * @param paymentRequired - The PaymentRequired response containing extension declarations
   * @returns The enriched payment payload with extension data applied
   */
  private async enrichPaymentPayloadWithExtensions(
    paymentPayload: PaymentPayload,
    paymentRequired: PaymentRequired,
  ): Promise<PaymentPayload> {
    if (!paymentRequired.extensions || this.registeredExtensions.size === 0) {
      return paymentPayload;
    }

    let enriched = paymentPayload;
    for (const [key, extension] of this.registeredExtensions) {
      if (key in paymentRequired.extensions && extension.enrichPaymentPayload) {
        enriched = await extension.enrichPaymentPayload(enriched, paymentRequired);
      }
    }

    return enriched;
  }

  /**
   * Selects appropriate payment requirements based on registered clients and policies.
   *
   * Selection process:
   * 1. Filter by registered schemes (network + scheme support)
   * 2. Apply all registered policies in order
   * 3. Use selector to choose final requirement
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

    // Step 2: Apply all policies in order
    let filteredRequirements = supportedPaymentRequirements;
    for (const policy of this.policies) {
      filteredRequirements = policy(x402Version, filteredRequirements);

      if (filteredRequirements.length === 0) {
        throw new Error(`All payment requirements were filtered out by policies for x402 version: ${x402Version}`);
      }
    }

    // Step 3: Use selector to choose final requirement
    return this.paymentRequirementsSelector(x402Version, filteredRequirements);
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
   * Returns manual hooks followed by the hook for the selected scheme, if present.
   *
   * @param phase - Hook slot to collect
   * @param x402Version - Protocol version for the selected requirement
   * @param requirements - Selected payment requirement
   * @returns Hooks in invocation order
   */
  private getLabeledHooks<P extends ClientHookPhase>(
    phase: P,
    x402Version: number,
    requirements: PaymentRequirements,
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
    return out;
  }
}
