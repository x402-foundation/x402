import {
  SettleError,
  SettleResponse,
  VerifyResponse,
  SupportedResponse,
  SupportedKind,
} from "../types/facilitator";
import {
  PaymentPayload,
  PaymentRequirements,
  PaymentRequired,
  ResourceInfo,
} from "../types/payments";
import { SchemeNetworkServer } from "../types/mechanisms";
import { Price, Network, ResourceServerExtension, VerifyError } from "../types";
import { deepEqual, findByNetworkAndScheme } from "../utils";
import { FacilitatorClient, HTTPFacilitatorClient } from "../http/httpFacilitatorClient";
import { x402Version } from "..";

/**
 * Configuration for a protected resource
 * Only contains payment-specific configuration, not resource metadata
 */
export interface ResourceConfig {
  scheme: string;
  payTo: string; // Payment recipient address
  price: Price;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>; // Scheme-specific additional data
}

/**
 * Lifecycle Hook Context Interfaces
 */

export interface PaymentRequiredContext {
  requirements: PaymentRequirements[];
  resourceInfo: ResourceInfo;
  error?: string;
  paymentRequiredResponse: PaymentRequired;
  transportContext?: unknown;
}

export interface VerifyContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface VerifyResultContext extends VerifyContext {
  result: VerifyResponse;
}

export interface VerifyFailureContext extends VerifyContext {
  error: Error;
}

export interface SettleContext {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
}

export interface SettleResultContext extends SettleContext {
  result: SettleResponse;
  transportContext?: unknown;
}

export interface SettleFailureContext extends SettleContext {
  error: Error;
}

/**
 * Lifecycle Hook Type Definitions
 */

export type BeforeVerifyHook = (
  context: VerifyContext,
) => Promise<void | { abort: true; reason: string; message?: string }>;

export type AfterVerifyHook = (context: VerifyResultContext) => Promise<void>;

export type OnVerifyFailureHook = (
  context: VerifyFailureContext,
) => Promise<void | { recovered: true; result: VerifyResponse }>;

export type BeforeSettleHook = (
  context: SettleContext,
) => Promise<void | { abort: true; reason: string; message?: string }>;

export type AfterSettleHook = (context: SettleResultContext) => Promise<void>;

export type OnSettleFailureHook = (
  context: SettleFailureContext,
) => Promise<void | { recovered: true; result: SettleResponse }>;

/**
 * Optional overrides for settlement parameters.
 * Used to support partial settlement (e.g., upto scheme billing by actual usage).
 *
 * Note: Overriding the amount to a value different from the agreed-upon
 * `PaymentRequirements.amount` is only valid in schemes that explicitly support
 * partial settlement, such as the `upto` scheme. Using this with standard
 * x402 schemes (e.g., `exact`) will likely cause settlement verification to fail.
 */
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
 * @param decimals - Decimal precision to use for dollar-format conversion (default 6)
 * @returns The resolved amount as an atomic-unit string
 */
export function resolveSettlementOverrideAmount(
  rawAmount: string,
  requirements: PaymentRequirements,
  decimals: number = 6,
): string {
  // Percent format: "50%" or "33.33%"
  const percentMatch = rawAmount.match(/^(\d+(?:\.\d{0,2})?)%$/);
  if (percentMatch) {
    const [intPart, decPart = ""] = percentMatch[1].split(".");
    const scaledPercent = BigInt(intPart) * 100n + BigInt(decPart.padEnd(2, "0").slice(0, 2));
    const base = BigInt(requirements.amount);
    return ((base * scaledPercent) / 10000n).toString();
  }

  // Dollar price format: "$0.05"
  const dollarMatch = rawAmount.match(/^\$(\d+(?:\.\d+)?)$/);
  if (dollarMatch) {
    const dollars = parseFloat(dollarMatch[1]);
    return Math.round(dollars * 10 ** decimals).toString();
  }

  // Raw atomic units (existing behavior)
  return rawAmount;
}

/**
 * Core x402 protocol server for resource protection
 * Transport-agnostic implementation of the x402 payment protocol
 */
export class x402ResourceServer {
  private facilitatorClients: FacilitatorClient[];
  private registeredServerSchemes: Map<string, Map<string, SchemeNetworkServer>> = new Map();
  private supportedResponsesMap: Map<number, Map<string, Map<string, SupportedResponse>>> =
    new Map();
  private facilitatorClientsMap: Map<number, Map<string, Map<string, FacilitatorClient>>> =
    new Map();
  private registeredExtensions: Map<string, ResourceServerExtension> = new Map();

  private beforeVerifyHooks: BeforeVerifyHook[] = [];
  private afterVerifyHooks: AfterVerifyHook[] = [];
  private onVerifyFailureHooks: OnVerifyFailureHook[] = [];
  private beforeSettleHooks: BeforeSettleHook[] = [];
  private afterSettleHooks: AfterSettleHook[] = [];
  private onSettleFailureHooks: OnSettleFailureHook[] = [];

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
    if (!serverByScheme.has(server.scheme)) {
      serverByScheme.set(server.scheme, server);
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
   * Registers a resource service extension that can enrich extension declarations.
   *
   * @param extension - The extension to register
   * @returns The x402ResourceServer instance for chaining
   */
  registerExtension(extension: ResourceServerExtension): this {
    this.registeredExtensions.set(extension.key, extension);
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
        enriched[key] = extension.enrichDeclaration(declaration, transportContext);
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
      // Fallback to placeholder implementation if no server registered
      // TODO: Remove this fallback once implementations are registered
      console.warn(
        `No server implementation registered for scheme: ${scheme}, network: ${resourceConfig.network}`,
      );
      return requirements;
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
    // Note: enhancePaymentRequirements expects x402Version in the kind, so we add it back
    const requirement = await SchemeNetworkServer.enhancePaymentRequirements(
      baseRequirements,
      {
        ...supportedKind,
        x402Version,
      },
      facilitatorExtensions,
    );

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
   * @returns Payment required response object
   */
  async createPaymentRequiredResponse(
    requirements: PaymentRequirements[],
    resourceInfo: ResourceInfo,
    error?: string,
    extensions?: Record<string, unknown>,
    transportContext?: unknown,
  ): Promise<PaymentRequired> {
    // V2 response with resource at top level
    let response: PaymentRequired = {
      x402Version: 2,
      error,
      resource: resourceInfo,
      accepts: requirements as PaymentRequirements[],
    };

    // Add extensions if provided
    if (extensions && Object.keys(extensions).length > 0) {
      response.extensions = extensions;
    }

    // Let declared extensions add data to PaymentRequired response
    if (extensions) {
      for (const [key, declaration] of Object.entries(extensions)) {
        const extension = this.registeredExtensions.get(key);
        if (extension?.enrichPaymentRequiredResponse) {
          try {
            const context: PaymentRequiredContext = {
              requirements,
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
            console.error(
              `Error in enrichPaymentRequiredResponse hook for extension ${key}:`,
              error,
            );
          }
        }
      }
    }

    return response;
  }

  /**
   * Verify a payment against requirements
   *
   * @param paymentPayload - The payment payload to verify
   * @param requirements - The payment requirements
   * @returns Verification response
   */
  async verifyPayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const context: VerifyContext = {
      paymentPayload,
      requirements,
    };

    // Execute beforeVerify hooks
    for (const hook of this.beforeVerifyHooks) {
      try {
        const result = await hook(context);
        if (result && "abort" in result && result.abort) {
          return {
            isValid: false,
            invalidReason: result.reason,
            invalidMessage: result.message,
          };
        }
      } catch (error) {
        throw new VerifyError(400, {
          isValid: false,
          invalidReason: "before_verify_hook_error",
          invalidMessage: error instanceof Error ? error.message : "",
        });
      }
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

      // Execute afterVerify hooks
      const resultContext: VerifyResultContext = {
        ...context,
        result: verifyResult,
      };

      for (const hook of this.afterVerifyHooks) {
        await hook(resultContext);
      }

      return verifyResult;
    } catch (error) {
      const failureContext: VerifyFailureContext = {
        ...context,
        error: error as Error,
      };

      // Execute onVerifyFailure hooks
      for (const hook of this.onVerifyFailureHooks) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.result;
        }
      }

      throw error;
    }
  }

  /**
   * Settle a verified payment
   *
   * @param paymentPayload - The payment payload to settle
   * @param requirements - The payment requirements
   * @param declaredExtensions - Optional declared extensions (for per-key enrichment)
   * @param transportContext - Optional transport-specific context (e.g., HTTP request/response, MCP tool context)
   * @param settlementOverrides - Optional overrides for settlement parameters (e.g., partial settlement amount)
   * @returns Settlement response
   */
  async settlePayment(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: unknown,
    settlementOverrides?: SettlementOverrides,
  ): Promise<SettleResponse> {
    // Apply settlement overrides (e.g., partial settlement for upto scheme)
    let effectiveRequirements = requirements;
    if (settlementOverrides?.amount !== undefined) {
      const scheme = findByNetworkAndScheme(
        this.registeredServerSchemes,
        requirements.scheme,
        requirements.network as Network,
      );
      const decimals =
        scheme?.getAssetDecimals?.(requirements.asset ?? "", requirements.network as Network) ?? 6;
      effectiveRequirements = {
        ...requirements,
        amount: resolveSettlementOverrideAmount(settlementOverrides.amount, requirements, decimals),
      };
    }

    const context: SettleContext = {
      paymentPayload,
      requirements: effectiveRequirements,
    };

    // Execute beforeSettle hooks
    for (const hook of this.beforeSettleHooks) {
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
      } catch (error) {
        if (error instanceof SettleError) {
          throw error;
        }
        throw new SettleError(400, {
          success: false,
          errorReason: "before_settle_hook_error",
          errorMessage: error instanceof Error ? error.message : "",
          transaction: "",
          network: requirements.network,
        });
      }
    }

    try {
      // Find the facilitator that supports this payment type
      const facilitatorClient = this.getFacilitatorClient(
        paymentPayload.x402Version,
        effectiveRequirements.network,
        effectiveRequirements.scheme,
      );

      let settleResult: SettleResponse;

      if (!facilitatorClient) {
        // Fallback: try all facilitators if no specific support found
        let lastError: Error | undefined;

        for (const client of this.facilitatorClients) {
          try {
            settleResult = await client.settle(paymentPayload, effectiveRequirements);
            break;
          } catch (error) {
            lastError = error as Error;
          }
        }

        if (!settleResult!) {
          throw (
            lastError ||
            new Error(
              `No facilitator supports ${effectiveRequirements.scheme} on ${effectiveRequirements.network} for v${paymentPayload.x402Version}`,
            )
          );
        }
      } else {
        // Use the specific facilitator that supports this payment
        settleResult = await facilitatorClient.settle(paymentPayload, effectiveRequirements);
      }

      // Execute afterSettle hooks
      const resultContext: SettleResultContext = {
        ...context,
        result: settleResult,
        transportContext,
      };

      for (const hook of this.afterSettleHooks) {
        await hook(resultContext);
      }

      // Let declared extensions add data to settlement response
      if (declaredExtensions) {
        for (const [key, declaration] of Object.entries(declaredExtensions)) {
          const extension = this.registeredExtensions.get(key);
          if (extension?.enrichSettlementResponse) {
            try {
              const extensionData = await extension.enrichSettlementResponse(
                declaration,
                resultContext,
              );
              if (extensionData !== undefined) {
                if (!settleResult.extensions) {
                  settleResult.extensions = {};
                }
                settleResult.extensions[key] = extensionData;
              }
            } catch (error) {
              console.error(`Error in enrichSettlementResponse hook for extension ${key}:`, error);
            }
          }
        }
      }

      return settleResult;
    } catch (error) {
      const failureContext: SettleFailureContext = {
        ...context,
        error: error as Error,
      };

      // Execute onSettleFailure hooks
      for (const hook of this.onSettleFailureHooks) {
        const result = await hook(failureContext);
        if (result && "recovered" in result && result.recovered) {
          return result.result;
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
  findMatchingRequirements(
    availableRequirements: PaymentRequirements[],
    paymentPayload: PaymentPayload,
  ): PaymentRequirements | undefined {
    switch (paymentPayload.x402Version) {
      case 2:
        // For v2, match by accepted requirements
        return availableRequirements.find(paymentRequirements =>
          deepEqual(paymentRequirements, paymentPayload.accepted),
        );
      case 1:
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
   * Process a payment request
   *
   * @param paymentPayload - Optional payment payload if provided
   * @param resourceConfig - Configuration for the protected resource
   * @param resourceInfo - Information about the resource being accessed
   * @param extensions - Optional extensions to include in the response
   * @returns Processing result
   */
  async processPaymentRequest(
    paymentPayload: PaymentPayload | null,
    resourceConfig: ResourceConfig,
    resourceInfo: ResourceInfo,
    extensions?: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    requiresPayment?: PaymentRequired;
    verificationResult?: VerifyResponse;
    settlementResult?: SettleResponse;
    error?: string;
  }> {
    const requirements = await this.buildPaymentRequirements(resourceConfig);

    if (!paymentPayload) {
      return {
        success: false,
        requiresPayment: await this.createPaymentRequiredResponse(
          requirements,
          resourceInfo,
          "Payment required",
          extensions,
        ),
      };
    }

    // Find matching requirements
    const matchingRequirements = this.findMatchingRequirements(requirements, paymentPayload);
    if (!matchingRequirements) {
      return {
        success: false,
        requiresPayment: await this.createPaymentRequiredResponse(
          requirements,
          resourceInfo,
          "No matching payment requirements found",
          extensions,
        ),
      };
    }

    // Verify payment
    const verificationResult = await this.verifyPayment(paymentPayload, matchingRequirements);
    if (!verificationResult.isValid) {
      return {
        success: false,
        error: verificationResult.invalidReason,
        verificationResult,
      };
    }

    // Payment verified, ready for settlement
    return {
      success: true,
      verificationResult,
    };
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

export default x402ResourceServer;
