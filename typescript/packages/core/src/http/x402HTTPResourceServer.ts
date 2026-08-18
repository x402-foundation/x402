import {
  x402ResourceServer,
  SettlementOverrides,
  SkipHandlerDirective,
  PaymentCancellationDispatcher,
  CompletedSettlement,
  SettlePhase,
  resolvePaymentFlow,
  resolvePaymentFlowPhases,
  resolveFailurePathSettlement,
} from "../server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from ".";
import {
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  SettleError,
  FacilitatorResponseError,
  Price,
  Network,
  PaymentRequirements,
} from "../types";
import { x402Version } from "..";

export const SETTLEMENT_OVERRIDES_HEADER = "Settlement-Overrides";

export const PAYMENT_REQUIRED_CACHE_CONTROL = "no-store";

/**
 * Appends the `private` directive to an existing Cache-Control header value.
 * Shared caches must not store responses with user-specific settlement metadata.
 *
 * @param value - Existing Cache-Control header value, or null/empty if unset
 * @returns Cache-Control value with `private` merged in
 */
export function withPrivateCacheControl(value: string | null): string {
  if (!value) {
    return "private";
  }

  const directives = value.split(",").map(directive => directive.trim().toLowerCase());
  if (directives.includes("private")) {
    return value;
  }

  return `${value}, private`;
}

/**
 * Framework-agnostic HTTP adapter interface
 * Implementations provide framework-specific HTTP operations
 */
export interface HTTPAdapter {
  getHeader(name: string): string | undefined;
  getMethod(): string;
  getPath(): string;
  getUrl(): string;
  getAcceptHeader(): string;
  getUserAgent(): string;

  /**
   * Get query parameters from the request URL
   *
   * @returns Record of query parameter key-value pairs
   */
  getQueryParams?(): Record<string, string | string[]>;

  /**
   * Get a specific query parameter by name
   *
   * @param name - The query parameter name
   * @returns The query parameter value(s) or undefined
   */
  getQueryParam?(name: string): string | string[] | undefined;

  /**
   * Get the parsed request body
   * Framework adapters should parse JSON/form data appropriately
   *
   * @returns The parsed request body
   */
  getBody?(): unknown;
}

/**
 * Paywall configuration for HTML responses
 */
export interface PaywallConfig {
  appName?: string;
  appLogo?: string;
  sessionTokenEndpoint?: string;
  currentUrl?: string;
  testnet?: boolean;
}

/**
 * Paywall provider interface for generating HTML
 */
export interface PaywallProvider {
  generateHtml(paymentRequired: PaymentRequired, config?: PaywallConfig): string;
}

/**
 * Dynamic payTo function that receives HTTP request context
 */
export type DynamicPayTo = (context: HTTPRequestContext) => string | Promise<string>;

/**
 * Dynamic price function that receives HTTP request context
 */
export type DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>;

/**
 * Result of response body callbacks containing content type and body.
 */
export interface HTTPResponseBody {
  /**
   * The content type for the response (e.g., 'application/json', 'text/plain').
   */
  contentType: string;

  /**
   * The response body to include in the 402 response.
   */
  body: unknown;
}

/**
 * Dynamic function to generate a custom response for unpaid requests.
 * Receives the HTTP request context and returns the content type and body to include in the 402 response.
 */
export type UnpaidResponseBody = (
  context: HTTPRequestContext,
) => HTTPResponseBody | Promise<HTTPResponseBody>;

/**
 * Dynamic function to generate a custom response for settlement failures.
 * Receives the HTTP request context and settle failure result, returns the content type and body.
 */
export type SettlementFailedResponseBody = (
  context: HTTPRequestContext,
  settleResult: Omit<ProcessSettleFailureResponse, "response">,
) => HTTPResponseBody | Promise<HTTPResponseBody>;

/**
 * A single payment option for a route
 * Represents one way a client can pay for access to the resource
 */
export interface PaymentOption {
  scheme: string;
  payTo: string | DynamicPayTo;
  price: Price | DynamicPrice;
  network: Network;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Route configuration for HTTP endpoints
 *
 * The 'accepts' field defines payment options for the route.
 * Can be a single PaymentOption or an array of PaymentOptions for multiple payment methods.
 */
export interface RouteConfig {
  // Payment option(s): single or array
  accepts: PaymentOption | PaymentOption[];

  // HTTP-specific metadata
  resource?: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  customPaywallHtml?: string;

  /**
   * Optional callback to generate a custom response for unpaid API requests.
   * This allows servers to return preview data, error messages, or other content
   * when a request lacks payment.
   *
   * For browser requests (Accept: text/html), the paywall HTML takes precedence.
   * This callback is only used for API clients.
   *
   * If not provided, defaults to { contentType: 'application/json', body: {} }.
   *
   * @param context - The HTTP request context
   * @returns An object containing both contentType and body for the 402 response
   */
  unpaidResponseBody?: UnpaidResponseBody;

  /**
   * Optional callback to generate a custom response for settlement failures.
   * If not provided, defaults to { contentType: 'application/json', body: {} }.
   *
   * @param context - The HTTP request context
   * @param settleResult - The settlement failure result
   * @returns An object containing both contentType and body for the 402 response
   */
  settlementFailedResponseBody?: SettlementFailedResponseBody;

  // Extensions
  extensions?: Record<string, unknown>;
}

/**
 * Routes configuration - maps path patterns to route configs
 */
export type RoutesConfig = Record<string, RouteConfig> | RouteConfig;

/**
 * Check if any routes in the configuration declare bazaar extensions.
 *
 * @param routes - Route configuration
 * @returns True if any route has extensions.bazaar defined
 */
export function checkIfBazaarNeeded(routes: RoutesConfig): boolean {
  if ("accepts" in routes) {
    return !!(routes.extensions && "bazaar" in routes.extensions);
  }

  return Object.values(routes).some(routeConfig => {
    return !!(routeConfig.extensions && "bazaar" in routeConfig.extensions);
  });
}

/**
 * Hook that runs on every request to a protected route, before payment processing.
 * Can grant access without payment, deny the request, or continue to payment flow.
 *
 * @returns
 * - `void` - Continue to payment processing (default behavior)
 * - `{ grantAccess: true }` - Grant access without requiring payment
 * - `{ abort: true; reason: string }` - Deny the request (returns 403)
 */
export type ProtectedRequestHook = (
  context: HTTPRequestContext,
  routeConfig: RouteConfig,
) => Promise<void | { grantAccess: true } | { abort: true; reason: string }>;

export interface HTTPResourceServerExtensionHooks {
  onProtectedRequest?: (
    declaration: unknown,
    context: HTTPRequestContext,
    routeConfig: RouteConfig,
  ) => Promise<void | { grantAccess: true } | { abort: true; reason: string }>;
}

export interface ResourceServerTransportExtensionHooks {
  http?: HTTPResourceServerExtensionHooks;
}

/**
 * Compiled route for efficient matching
 */
export interface CompiledRoute {
  verb: string;
  regex: RegExp;
  config: RouteConfig;
  pattern: string;
}

/**
 * HTTP request context that encapsulates all request data
 */
export interface HTTPRequestContext {
  adapter: HTTPAdapter;
  path: string;
  method: string;
  paymentHeader?: string;
  routePattern?: string;
}

/**
 * HTTP transport context contains both request context and optional response data.
 */
export interface HTTPTransportContext {
  /** The HTTP request context */
  request: HTTPRequestContext;
  /** The response body buffer */
  responseBody?: Buffer;
  /** Response headers set by the route handler (used for settlement overrides) */
  responseHeaders?: Record<string, string>;
}

/**
 * HTTP response instructions for the framework middleware
 */
export interface HTTPResponseInstructions {
  status: number;
  headers: Record<string, string>;
  body?: unknown; // e.g. Paywall for web browser requests, but could be any other type
  isHtml?: boolean; // e.g. if body is a paywall, then isHtml is true
}

/**
 * Result of processing an HTTP request for payment
 */
export type HTTPProcessResult =
  | { type: "no-payment-required" }
  | {
      type: "payment-verified";
      cancellationDispatcher: PaymentCancellationDispatcher;
      beforeHandlerSettlement?: CompletedSettlement;
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
      declaredExtensions?: Record<string, unknown>;
    }
  | { type: "payment-error"; response: HTTPResponseInstructions };

/**
 * Result of processSettlement
 */
export type ProcessSettleSuccessResponse = SettleResponse & {
  success: true;
  headers: Record<string, string>;
  requirements: PaymentRequirements;
};

export type ProcessSettleFailureResponse = SettleResponse & {
  success: false;
  errorReason: string;
  errorMessage?: string;
  headers: Record<string, string>;
  response: HTTPResponseInstructions;
};

export type ProcessSettleResultResponse =
  | ProcessSettleSuccessResponse
  | ProcessSettleFailureResponse;

/**
 * Represents a validation error for a specific route's payment configuration.
 */
export interface RouteValidationError {
  /** The route pattern (e.g., "GET /api/weather") */
  routePattern: string;
  /** The payment scheme that failed validation */
  scheme: string;
  /** The network that failed validation */
  network: Network;
  /** The type of validation failure */
  reason:
    | "missing_scheme"
    | "missing_facilitator"
    | "unsupported_asset_transfer_method"
    | "unsupported_payment_flow";
  /** Human-readable error message */
  message: string;
}

/**
 * Error thrown when route configuration validation fails.
 */
export class RouteConfigurationError extends Error {
  /** The validation errors that caused this exception */
  public readonly errors: RouteValidationError[];

  /**
   * Creates a new RouteConfigurationError with the given validation errors.
   *
   * @param errors - The validation errors that caused this exception.
   */
  constructor(errors: RouteValidationError[]) {
    const message = `x402 Route Configuration Errors:\n${errors.map(e => `  - ${e.message}`).join("\n")}`;
    super(message);
    this.name = "RouteConfigurationError";
    this.errors = errors;
  }
}

// Static fallback paywall served when @x402/paywall is not installed.
// Intentionally contains zero request- or config-derived interpolation:
// the protocol-level payment requirements still ship in response headers
// and the JSON 402 body for non-browser clients, so any agent or SDK can
// read them without us reflecting attacker-controlled bytes into HTML.
// Browser-end-user payment requires installing @x402/paywall.
const FALLBACK_PAYWALL_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Payment Required</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body>
    <div style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui, -apple-system, sans-serif;">
      <h1>Payment Required</h1>
      <p>This resource is protected by the x402 payment protocol.</p>
      <p style="margin-top: 2rem; padding: 1rem; background: #fef3c7; border-radius: 0.5rem;">
        <strong>Note to developers:</strong> install <code>@x402/paywall</code> to enable
        the in-browser wallet connection and payment UI. Programmatic clients should read
        the payment requirements from the 402 response headers and JSON body.
      </p>
    </div>
  </body>
</html>`;

/**
 * HTTP-enhanced x402 resource server
 * Provides framework-agnostic HTTP protocol handling
 */
export class x402HTTPResourceServer {
  private ResourceServer: x402ResourceServer;
  private compiledRoutes: CompiledRoute[] = [];
  private routesConfig: RoutesConfig;
  private paywallProvider?: PaywallProvider;
  private protectedRequestHooks: ProtectedRequestHook[] = [];
  private warnedMissingBeforeHandlerSettlement = false;

  /**
   * Creates a new x402HTTPResourceServer instance.
   *
   * @param ResourceServer - The core x402ResourceServer instance to use
   * @param routes - Route configuration for payment-protected endpoints
   * @throws RouteConfigurationError if a registered scheme does not support the
   *         declared paymentFlow / assetTransferMethod
   */
  constructor(ResourceServer: x402ResourceServer, routes: RoutesConfig) {
    this.ResourceServer = ResourceServer;
    this.routesConfig = routes;

    // Handle both single route and multiple routes
    const normalizedRoutes =
      typeof routes === "object" && !("accepts" in routes)
        ? (routes as Record<string, RouteConfig>)
        : { "*": routes as RouteConfig };

    for (const [pattern, config] of Object.entries(normalizedRoutes)) {
      const parsed = this.parseRoutePattern(pattern);
      this.compiledRoutes.push({
        verb: parsed.verb,
        regex: parsed.regex,
        config,
        pattern: parsed.path,
      });
    }

    const paymentFlowErrors = this.validateRouteConfiguration({
      includeMissingScheme: false,
      includeFacilitator: false,
    });
    if (paymentFlowErrors.length > 0) {
      throw new RouteConfigurationError(paymentFlowErrors);
    }
  }

  /**
   * Get the underlying x402ResourceServer instance.
   *
   * @returns The underlying x402ResourceServer instance
   */
  get server(): x402ResourceServer {
    return this.ResourceServer;
  }

  /**
   * Get the routes configuration.
   *
   * @returns The routes configuration
   */
  get routes(): RoutesConfig {
    return this.routesConfig;
  }

  /**
   * Initialize the HTTP resource server.
   *
   * This method initializes the underlying resource server (fetching facilitator support)
   * and then validates that all route payment configurations have corresponding
   * registered schemes and facilitator support.
   *
   * @throws RouteConfigurationError if any route's payment options don't have
   *         corresponding registered schemes or facilitator support
   *
   * @example
   * ```typescript
   * const httpServer = new x402HTTPResourceServer(server, routes);
   * await httpServer.initialize();
   * ```
   */
  async initialize(): Promise<void> {
    // First, initialize the underlying resource server (fetches facilitator support)
    await this.ResourceServer.initialize();

    // Then validate route configuration
    const errors = this.validateRouteConfiguration();
    if (errors.length > 0) {
      throw new RouteConfigurationError(errors);
    }
  }

  /**
   * Register a custom paywall provider for generating HTML
   *
   * @param provider - PaywallProvider instance
   * @returns This service instance for chaining
   */
  registerPaywallProvider(provider: PaywallProvider): this {
    this.paywallProvider = provider;
    return this;
  }

  /**
   * Register a hook that runs on every request to a protected route, before payment processing.
   * Hooks are executed in order of registration. The first hook to return a non-void result wins.
   *
   * @param hook - The request hook function
   * @returns The x402HTTPResourceServer instance for chaining
   */
  onProtectedRequest(hook: ProtectedRequestHook): this {
    this.protectedRequestHooks.push(hook);
    return this;
  }

  /**
   * Process HTTP request and return response instructions
   * This is the main entry point for framework middleware
   *
   * @param context - HTTP request context
   * @param paywallConfig - Optional paywall configuration
   * @returns Process result indicating next action for middleware
   */
  async processHTTPRequest(
    context: HTTPRequestContext,
    paywallConfig?: PaywallConfig,
  ): Promise<HTTPProcessResult> {
    const method = context.method || context.adapter.getMethod();
    context = { ...context, method };
    const { adapter, path } = context;

    // Find matching route
    const routeMatch = this.getRouteConfig(path, method);
    if (!routeMatch) {
      return { type: "no-payment-required" }; // No payment required for this route
    }
    const { config: routeConfig, pattern: routePattern } = routeMatch;
    const enrichedContext: HTTPRequestContext = { ...context, routePattern };

    // Execute request hooks before any payment processing
    for (const hook of this.getProtectedRequestHooks(routeConfig)) {
      const result = await hook(enrichedContext, routeConfig);
      if (result && "grantAccess" in result) {
        return { type: "no-payment-required" };
      }
      if (result && "abort" in result) {
        return {
          type: "payment-error",
          response: {
            status: 403,
            headers: { "Content-Type": "application/json" },
            body: { error: result.reason },
          },
        };
      }
    }

    // Normalize accepts field to array of payment options
    const paymentOptions = this.normalizePaymentOptions(routeConfig);

    // Check for payment header (v1 or v2)
    const paymentPayload = this.extractPayment(adapter);

    // Create resource info, using config override if provided
    const resourceInfo = {
      url: routeConfig.resource || enrichedContext.adapter.getUrl(),
      description: routeConfig.description || "",
      mimeType: routeConfig.mimeType || "",
      ...(routeConfig.serviceName !== undefined && { serviceName: routeConfig.serviceName }),
      ...(routeConfig.tags !== undefined && { tags: routeConfig.tags }),
      ...(routeConfig.iconUrl !== undefined && { iconUrl: routeConfig.iconUrl }),
    };

    // Build requirements from all payment options
    // (this method handles resolving dynamic functions internally)
    let requirements = await this.ResourceServer.buildPaymentRequirementsFromOptions(
      paymentOptions,
      enrichedContext,
    );

    let extensions = routeConfig.extensions;
    if (extensions) {
      extensions = this.ResourceServer.enrichExtensions(extensions, enrichedContext);
    }

    // createPaymentRequiredResponse already handles extension enrichment in the core layer
    const transportContext: HTTPTransportContext = { request: enrichedContext };
    const paymentRequired = await this.ResourceServer.createPaymentRequiredResponse(
      requirements,
      resourceInfo,
      !paymentPayload ? "Payment required" : undefined,
      extensions,
      transportContext,
    );

    // If no payment provided
    if (!paymentPayload) {
      // Resolve custom unpaid response body if provided
      const unpaidBody = routeConfig.unpaidResponseBody
        ? await routeConfig.unpaidResponseBody(enrichedContext)
        : undefined;

      return {
        type: "payment-error",
        response: this.createHTTPResponse(
          paymentRequired,
          this.isWebBrowser(adapter),
          paywallConfig,
          routeConfig.customPaywallHtml,
          unpaidBody,
        ),
      };
    }

    // Match requirements, resolve flow, then verify/settle per flow phases
    try {
      const matchingRequirements = this.ResourceServer.findMatchingRequirements(
        paymentRequired.accepts,
        paymentPayload,
      );

      if (!matchingRequirements) {
        const errorResponse = await this.ResourceServer.createPaymentRequiredResponse(
          requirements,
          resourceInfo,
          "No matching payment requirements",
          extensions,
          transportContext,
        );
        return {
          type: "payment-error",
          response: this.createHTTPResponse(errorResponse, false, paywallConfig),
        };
      }

      const extensionResult = this.ResourceServer.validateExtensions(
        paymentRequired,
        paymentPayload,
      );
      if (!extensionResult.valid) {
        const errorResponse = await this.ResourceServer.createPaymentRequiredResponse(
          requirements,
          resourceInfo,
          extensionResult.invalidReason,
          extensions,
          transportContext,
          paymentPayload,
        );
        return {
          type: "payment-error",
          response: this.createHTTPResponse(errorResponse, false, paywallConfig),
        };
      }

      const flow = this.ResourceServer.getPaymentFlow(paymentPayload, matchingRequirements);
      const phases = resolvePaymentFlowPhases(flow);

      const verifyResult = await this.ResourceServer.verifyPayment(
        paymentPayload,
        matchingRequirements,
        extensions,
        transportContext,
      );

      if (!verifyResult.isValid) {
        const errorResponse = await this.ResourceServer.createPaymentRequiredResponse(
          requirements,
          resourceInfo,
          verifyResult.invalidReason,
          extensions,
          transportContext,
          paymentPayload,
        );
        return {
          type: "payment-error",
          response: this.createHTTPResponse(errorResponse, false, paywallConfig),
        };
      }

      // Bypass the resource handler
      if (verifyResult.skipHandler) {
        return await this.processSkipHandlerSettlement(
          paymentPayload,
          matchingRequirements,
          extensions,
          transportContext,
          verifyResult.skipHandler,
        );
      }

      let beforeHandlerSettlement: CompletedSettlement | undefined;

      if (phases.settleBeforeHandler) {
        const beforeSettleResult = await this.processSettlement(
          paymentPayload,
          matchingRequirements,
          extensions,
          transportContext,
          undefined,
          undefined,
          "before-handler",
        );
        if (!beforeSettleResult.success) {
          return { type: "payment-error", response: beforeSettleResult.response };
        }
        // Store SettleResponse only — omit SDK-only headers from CompletedSettlement.
        const { result, requirements } = (({ headers: _, requirements, ...result }) => ({
          result,
          requirements,
        }))(beforeSettleResult);
        beforeHandlerSettlement = {
          phase: "before-handler",
          flow,
          result,
          requirements,
        };
      }

      const cancellationDispatcher = this.ResourceServer.createPaymentCancellationDispatcher(
        paymentPayload,
        matchingRequirements,
        extensions,
        transportContext,
        beforeHandlerSettlement ? ["before-handler"] : [],
      );

      return {
        type: "payment-verified",
        cancellationDispatcher,
        beforeHandlerSettlement,
        paymentPayload,
        paymentRequirements: matchingRequirements,
        declaredExtensions: extensions,
      };
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        throw error;
      }
      const errorResponse = await this.ResourceServer.createPaymentRequiredResponse(
        requirements,
        resourceInfo,
        error instanceof Error ? error.message : "Payment verification failed",
        extensions,
        transportContext,
      );
      return {
        type: "payment-error",
        response: this.createHTTPResponse(errorResponse, false, paywallConfig),
      };
    }
  }

  /**
   * Process settlement after successful response
   *
   * @param paymentPayload - The verified payment payload
   * @param requirements - The matching payment requirements
   * @param declaredExtensions - Optional declared extensions (for per-key enrichment)
   * @param transportContext - Optional HTTP transport context
   * @param settlementOverrides - Optional settlement overrides (e.g., partial settlement amount)
   * @param beforeHandlerSettlement - Before-handler settle from processHTTPRequest (for PAYMENT-RESPONSE echo)
   * @param phase - Explicit settle phase; omit to derive from the payment flow
   * @returns ProcessSettleResultResponse - SettleResponse with headers if success or errorReason if failure
   */
  async processSettlement(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions?: Record<string, unknown>,
    transportContext?: HTTPTransportContext,
    settlementOverrides?: SettlementOverrides,
    beforeHandlerSettlement?: CompletedSettlement,
    phase?: SettlePhase,
  ): Promise<ProcessSettleResultResponse> {
    if (transportContext?.request && !transportContext.request.method) {
      transportContext = {
        ...transportContext,
        request: {
          ...transportContext.request,
          method: transportContext.request.adapter.getMethod(),
        },
      };
    }

    const flow =
      beforeHandlerSettlement?.flow ??
      this.ResourceServer.getPaymentFlow(paymentPayload, requirements);
    const phases = resolvePaymentFlowPhases(flow);

    // After-handler path for flows that do not settle again: echo before-handler settle or no-op.
    if (phase !== "before-handler" && !phases.settleAfterHandler) {
      if (beforeHandlerSettlement) {
        return {
          ...beforeHandlerSettlement.result,
          success: true,
          headers: this.createSettlementHeaders(beforeHandlerSettlement.result),
          requirements: beforeHandlerSettlement.requirements,
        };
      }
      if (phases.settleBeforeHandler && !beforeHandlerSettlement) {
        if (!this.warnedMissingBeforeHandlerSettlement) {
          this.warnedMissingBeforeHandlerSettlement = true;
          console.warn(
            `[x402] Payment flow "${flow}" settles before the handler, but processSettlement was called without beforeHandlerSettlement from processHTTPRequest. Skipping after-handler settle. Pass that settle result to echo the before-handler PAYMENT-RESPONSE.`,
          );
        }
      }
      return {
        success: true,
        transaction: "",
        network: requirements.network as Network,
        headers: {},
        requirements,
      };
    }

    const resolvedPhase: SettlePhase = phase ?? "after-handler";

    try {
      // Resolve overrides: explicit param takes precedence, fall back to response header
      let resolvedOverrides = settlementOverrides;
      if (!resolvedOverrides && transportContext?.responseHeaders) {
        const overridesKey = SETTLEMENT_OVERRIDES_HEADER.toLowerCase();
        const rawValue = Object.entries(transportContext.responseHeaders).find(
          ([key]) => key.toLowerCase() === overridesKey,
        )?.[1];
        if (rawValue) {
          try {
            resolvedOverrides = JSON.parse(rawValue);
          } catch {
            // Ignore malformed header
          }
        }
      }

      const settleResponse = await this.ResourceServer.settlePayment(
        paymentPayload,
        requirements,
        declaredExtensions,
        transportContext,
        resolvedOverrides,
        resolvedPhase,
      );

      if (!settleResponse.success) {
        const errorReason = settleResponse.errorReason || "Settlement failed";
        const failure = {
          ...settleResponse,
          success: false as const,
          errorReason,
          errorMessage: settleResponse.errorMessage || errorReason,
          headers: this.createSettlementHeaders(settleResponse),
        };
        const response = await this.buildSettlementFailureResponse(failure, transportContext);
        return { ...failure, response };
      }

      return {
        ...settleResponse,
        success: true,
        headers: this.createSettlementHeaders(settleResponse),
        requirements,
      };
    } catch (error) {
      if (error instanceof FacilitatorResponseError) {
        throw error;
      }
      if (error instanceof SettleError) {
        const errorReason = error.errorReason || error.message;
        const settleResponse: SettleResponse = {
          success: false,
          errorReason,
          errorMessage: error.errorMessage || errorReason,
          payer: error.payer,
          network: error.network,
          transaction: error.transaction,
        };
        const failure = {
          ...settleResponse,
          success: false as const,
          errorReason,
          headers: this.createSettlementHeaders(settleResponse),
        };
        const response = await this.buildSettlementFailureResponse(failure, transportContext);
        return { ...failure, response };
      }
      const errorReason = error instanceof Error ? error.message : "Settlement failed";
      const settleResponse: SettleResponse = {
        success: false,
        errorReason,
        errorMessage: errorReason,
        network: requirements.network as Network,
        transaction: "",
      };
      const failure = {
        ...settleResponse,
        success: false as const,
        errorReason,
        headers: this.createSettlementHeaders(settleResponse),
      };
      const response = await this.buildSettlementFailureResponse(failure, transportContext);
      return { ...failure, response };
    }
  }

  /**
   * Check if a request requires payment based on route configuration
   *
   * @param context - HTTP request context
   * @returns True if the route requires payment, false otherwise
   */
  requiresPayment(context: HTTPRequestContext): boolean {
    const method = context.method || context.adapter.getMethod();
    return this.getRouteConfig(context.path, method) !== undefined;
  }

  /**
   * Create settlement response headers
   *
   * @param settleResponse - Settlement response
   * @returns Headers to add to response
   */
  createSettlementHeaders(settleResponse: SettleResponse): Record<string, string> {
    const encoded = encodePaymentResponseHeader(settleResponse);
    return { "PAYMENT-RESPONSE": encoded };
  }

  /**
   * Headers for echoing a completed before-handler settle onto a response.
   * Merges `private` into Cache-Control so shared caches do not store settlement metadata.
   *
   * Used when the resource handler fails after payment was already committed (e.g. `upfront`).
   *
   * @param settlement - Completed before-handler settle
   * @param existingCacheControl - Existing Cache-Control value, if any
   * @returns PAYMENT-RESPONSE and Cache-Control headers
   */
  createCompletedSettlementHeaders(
    settlement: CompletedSettlement,
    existingCacheControl?: string | null,
  ): Record<string, string> {
    return {
      ...this.createSettlementHeaders(settlement.result),
      "Cache-Control": withPrivateCacheControl(existingCacheControl ?? null),
    };
  }

  /**
   * PAYMENT-RESPONSE headers when the resource handler fails after before-handler settle.
   * Prefers cancel/refund settle when present; otherwise echoes the upfront deposit receipt.
   *
   * @param cancelSettlement - Result from {@link PaymentCancellationDispatcher.cancel}, if any
   * @param beforeHandlerSettlement - Completed before-handler settle, when present
   * @param paymentPayload - Client payment payload (for escrow deposit recovery fields)
   * @param existingCacheControl - Existing Cache-Control value, if any
   * @returns PAYMENT-RESPONSE and Cache-Control headers, or undefined when neither receipt applies
   */
  createFailurePathSettlementHeaders(
    cancelSettlement: SettleResponse | void | undefined,
    beforeHandlerSettlement?: CompletedSettlement,
    paymentPayload?: PaymentPayload,
    existingCacheControl?: string | null,
  ): Record<string, string> | undefined {
    const receipt = resolveFailurePathSettlement(
      cancelSettlement,
      beforeHandlerSettlement,
      paymentPayload,
    );
    if (!receipt) {
      return undefined;
    }
    return {
      ...this.createSettlementHeaders(receipt),
      "Cache-Control": withPrivateCacheControl(existingCacheControl ?? null),
    };
  }

  /**
   * Settle a verified payment that requested `skipHandler`, packaging the
   * result as a `payment-error` HTTPProcessResult so framework adapters can
   * write the response without invoking the route handler.
   *
   * - On success: status 200 + PAYMENT-RESPONSE header + configured body.
   * - On failure: the standard 402 settlement-failure response.
   *
   * @param paymentPayload - Verified payment payload.
   * @param requirements - Matched payment requirements.
   * @param declaredExtensions - Optional declared extensions for the route.
   * @param transportContext - Optional HTTP transport context.
   * @param skipHandlerResponse - Optional content type + body to return on success.
   * @returns A `payment-error` HTTPProcessResult carrying the final response.
   */
  private async processSkipHandlerSettlement(
    paymentPayload: PaymentPayload,
    requirements: PaymentRequirements,
    declaredExtensions: Record<string, unknown> | undefined,
    transportContext: HTTPTransportContext,
    skipHandlerResponse: SkipHandlerDirective | undefined,
  ): Promise<HTTPProcessResult> {
    const settleResult = await this.processSettlement(
      paymentPayload,
      requirements,
      declaredExtensions,
      transportContext,
      undefined,
      undefined,
      "after-handler",
    );

    if (!settleResult.success) {
      return { type: "payment-error", response: settleResult.response };
    }

    const contentType = skipHandlerResponse?.contentType ?? "application/json";
    const body = skipHandlerResponse?.body ?? {};

    return {
      type: "payment-error",
      response: {
        status: 200,
        headers: {
          "Content-Type": contentType,
          ...settleResult.headers,
          "Cache-Control": withPrivateCacheControl(null),
        },
        body,
        isHtml: contentType.includes("text/html"),
      },
    };
  }

  /**
   * Build HTTPResponseInstructions for settlement failure.
   * Uses settlementFailedResponseBody hook if configured, otherwise defaults to empty body.
   *
   * @param failure - Settlement failure result with headers
   * @param transportContext - Optional HTTP transport context for the request
   * @returns HTTP response instructions for the 402 settlement failure response
   */
  private async buildSettlementFailureResponse(
    failure: Omit<ProcessSettleFailureResponse, "response">,
    transportContext?: HTTPTransportContext,
  ): Promise<HTTPResponseInstructions> {
    const settlementHeaders = failure.headers;
    const routeConfig = transportContext
      ? this.getRouteConfig(transportContext.request.path, transportContext.request.method)
      : undefined;

    const customBody = routeConfig?.config.settlementFailedResponseBody
      ? await routeConfig.config.settlementFailedResponseBody(transportContext!.request, failure)
      : undefined;

    const contentType = customBody ? customBody.contentType : "application/json";
    const body = customBody ? customBody.body : {};

    return {
      status: 402,
      headers: {
        "Content-Type": contentType,
        ...settlementHeaders,
        "Cache-Control": PAYMENT_REQUIRED_CACHE_CONTROL,
      },
      body,
      isHtml: contentType.includes("text/html"),
    };
  }

  /**
   * Normalizes a RouteConfig's accepts field into an array of PaymentOptions
   * Handles both single PaymentOption and array formats
   *
   * @param routeConfig - Route configuration
   * @returns Array of payment options
   */
  private normalizePaymentOptions(routeConfig: RouteConfig): PaymentOption[] {
    return Array.isArray(routeConfig.accepts) ? routeConfig.accepts : [routeConfig.accepts];
  }

  /**
   * Manual request hooks run before extension transport hooks for declared extensions.
   *
   * @param routeConfig - Route configuration for the matched request
   * @returns Hooks in invocation order
   */
  private getProtectedRequestHooks(routeConfig: RouteConfig): ProtectedRequestHook[] {
    const hooks = [...this.protectedRequestHooks];
    const declaredExtensions = routeConfig.extensions;
    if (!declaredExtensions) return hooks;

    for (const extension of this.ResourceServer.getExtensions()) {
      const hook = extension.transportHooks?.http?.onProtectedRequest;
      if (!hook || !(extension.key in declaredExtensions)) continue;

      hooks.push((context, routeConfig) =>
        hook(declaredExtensions[extension.key], context, routeConfig),
      );
    }

    return hooks;
  }

  /**
   * Validates that all payment options in routes have corresponding registered schemes,
   * supported paymentFlow / assetTransferMethod and facilitator support.
   *
   * @param options - Validation options
   * @param options.includeMissingScheme - When true (default), report unregistered schemes
   * @param options.includeFacilitator - When true (default), also check facilitator kinds
   * @returns Array of validation errors (empty if all routes are valid)
   */
  private validateRouteConfiguration(
    options: { includeMissingScheme?: boolean; includeFacilitator?: boolean } = {},
  ): RouteValidationError[] {
    const includeMissingScheme = options.includeMissingScheme !== false;
    const includeFacilitator = options.includeFacilitator !== false;
    const errors: RouteValidationError[] = [];

    // Normalize routes to array of [pattern, config] pairs
    const normalizedRoutes =
      typeof this.routesConfig === "object" && !("accepts" in this.routesConfig)
        ? Object.entries(this.routesConfig as Record<string, RouteConfig>)
        : [["*", this.routesConfig as RouteConfig] as [string, RouteConfig]];

    for (const [pattern, config] of normalizedRoutes) {
      // Warn if wildcard routes are used with discovery extensions
      const pathPart = pattern.includes(" ") ? pattern.split(/\s+/)[1] : pattern;
      if (
        pathPart &&
        pathPart.includes("*") &&
        config.extensions &&
        "bazaar" in config.extensions
      ) {
        console.warn(
          `[x402] Route "${pattern}": Wildcard (*) patterns with bazaar discovery extensions ` +
            `will auto-generate parameter names (var1, var2, ...). ` +
            `Consider using named parameters instead (e.g. /weather/:city) for better discovery metadata.`,
        );
      }

      const paymentOptions = this.normalizePaymentOptions(config);

      for (const option of paymentOptions) {
        // Check 1: Is scheme registered?
        const schemeServer = this.ResourceServer.getRegisteredScheme(option.network, option.scheme);
        if (!schemeServer) {
          if (includeMissingScheme) {
            errors.push({
              routePattern: pattern,
              scheme: option.scheme,
              network: option.network,
              reason: "missing_scheme",
              message: `Route "${pattern}": No scheme implementation registered for "${option.scheme}" on network "${option.network}"`,
            });
          }
          // Skip further checks if scheme isn't registered
          continue;
        }

        // Check 2: Does the scheme support the declared ATM / paymentFlow?
        const atm =
          typeof option.extra?.assetTransferMethod === "string"
            ? option.extra.assetTransferMethod
            : schemeServer.defaultAssetTransferMethod;
        if (!schemeServer.paymentFlows[atm]) {
          errors.push({
            routePattern: pattern,
            scheme: option.scheme,
            network: option.network,
            reason: "unsupported_asset_transfer_method",
            message:
              `Route "${pattern}": [x402] Scheme "${schemeServer.scheme}" does not support ` +
              `assetTransferMethod "${atm}". Supported: ${Object.keys(schemeServer.paymentFlows).join(", ")}.`,
          });
          continue;
        }

        try {
          resolvePaymentFlow(schemeServer, {
            scheme: option.scheme,
            network: option.network,
            asset: "",
            amount: "0",
            payTo: "",
            maxTimeoutSeconds: 0,
            extra: option.extra ?? {},
          });
        } catch (error) {
          errors.push({
            routePattern: pattern,
            scheme: option.scheme,
            network: option.network,
            reason: "unsupported_payment_flow",
            message:
              error instanceof Error
                ? `Route "${pattern}": ${error.message}`
                : `Route "${pattern}": Unsupported paymentFlow`,
          });
        }

        if (!includeFacilitator) {
          continue;
        }

        // Check 3: Does facilitator support this scheme/network combination?
        const supportedKind = this.ResourceServer.getSupportedKind(
          x402Version,
          option.network,
          option.scheme,
        );

        if (!supportedKind) {
          errors.push({
            routePattern: pattern,
            scheme: option.scheme,
            network: option.network,
            reason: "missing_facilitator",
            message: `Route "${pattern}": Facilitator does not support scheme "${option.scheme}" on network "${option.network}"`,
          });
        }
      }
    }

    return errors;
  }

  /**
   * Get route configuration for a request
   *
   * @param path - Request path
   * @param method - HTTP method
   * @returns Route configuration and pattern, or undefined if no match
   */
  private getRouteConfig(
    path: string,
    method: string,
  ): { config: RouteConfig; pattern: string } | undefined {
    const normalizedPath = this.normalizePath(path);
    const upperMethod = method.toUpperCase();

    const matchingRoute = this.compiledRoutes.find(
      route =>
        route.regex.test(normalizedPath) && (route.verb === "*" || route.verb === upperMethod),
    );

    if (!matchingRoute) return undefined;
    return { config: matchingRoute.config, pattern: matchingRoute.pattern };
  }

  /**
   * Extract payment from HTTP headers (handles v1 and v2)
   *
   * @param adapter - HTTP adapter
   * @returns Decoded payment payload or null
   */
  private extractPayment(adapter: HTTPAdapter): PaymentPayload | null {
    // Check v2 header first (PAYMENT-SIGNATURE)
    const header = adapter.getHeader("payment-signature") || adapter.getHeader("PAYMENT-SIGNATURE");

    if (header) {
      try {
        return decodePaymentSignatureHeader(header);
      } catch (error) {
        console.warn("Failed to decode PAYMENT-SIGNATURE header:", error);
      }
    }

    return null;
  }

  /**
   * Check if request is from a web browser
   *
   * @param adapter - HTTP adapter
   * @returns True if request appears to be from a browser
   */
  private isWebBrowser(adapter: HTTPAdapter): boolean {
    const accept = adapter.getAcceptHeader();
    const userAgent = adapter.getUserAgent();
    return accept.includes("text/html") && userAgent.includes("Mozilla");
  }

  /**
   * Create HTTP response instructions from payment required
   *
   * @param paymentRequired - Payment requirements
   * @param isWebBrowser - Whether request is from browser
   * @param paywallConfig - Paywall configuration
   * @param customHtml - Custom HTML template
   * @param unpaidResponse - Optional custom response (content type and body) for unpaid API requests
   * @returns Response instructions
   */
  private createHTTPResponse(
    paymentRequired: PaymentRequired,
    isWebBrowser: boolean,
    paywallConfig?: PaywallConfig,
    customHtml?: string,
    unpaidResponse?: HTTPResponseBody,
  ): HTTPResponseInstructions {
    // Use 412 Precondition Failed for permit2_allowance_required error
    // This signals client needs to approve Permit2 before retrying
    const status = paymentRequired.error === "permit2_allowance_required" ? 412 : 402;
    const response = this.createHTTPPaymentRequiredResponse(paymentRequired);

    if (isWebBrowser) {
      const html = this.generatePaywallHTML(paymentRequired, paywallConfig, customHtml);
      return {
        status,
        headers: {
          "Content-Type": "text/html",
          ...response.headers,
        },
        body: html,
        isHtml: true,
      };
    }

    // Use callback result if provided, otherwise default to JSON with empty object
    const contentType = unpaidResponse ? unpaidResponse.contentType : "application/json";
    const body = unpaidResponse ? unpaidResponse.body : {};

    return {
      status,
      headers: {
        "Content-Type": contentType,
        ...response.headers,
      },
      body,
    };
  }

  /**
   * Create HTTP payment required response (v1 puts in body, v2 puts in header)
   *
   * @param paymentRequired - Payment required object
   * @returns Headers and body for the HTTP response
   */
  private createHTTPPaymentRequiredResponse(paymentRequired: PaymentRequired): {
    headers: Record<string, string>;
  } {
    return {
      headers: {
        "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
        "Cache-Control": PAYMENT_REQUIRED_CACHE_CONTROL,
      },
    };
  }

  /**
   * Parse route pattern into verb and regex
   *
   * @param pattern - Route pattern like "GET /api/*", "/api/[id]", or "/api/:id"
   * @returns Parsed pattern with verb and regex
   */
  private parseRoutePattern(pattern: string): { verb: string; regex: RegExp; path: string } {
    const [verb, path] = pattern.includes(" ") ? pattern.split(/\s+/) : ["*", pattern];

    // A trailing "/*" must also match the bare prefix. normalizePath strips the
    // trailing slash, so a request for "/api/premium/" arrives as "/api/premium",
    // which a literal "/.*?" suffix would not match even though routers dispatch
    // it to the protected handler.
    const trailingWildcard = path.endsWith("/*");
    const pathForRegex = trailingWildcard ? path.slice(0, -2) : path;

    let regexBody = pathForRegex
      .replace(/\\/g, "\\\\") // Escape backslashes first
      .replace(/[$()+.?^{|}]/g, "\\$&") // Escape regex special chars
      .replace(/\*/g, ".*?") // Wildcards
      .replace(/\[([^\]]+)\]/g, "[^/]+") // Parameters (Next.js style [param])
      .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "[^/]+") // Parameters (Express style :param)
      .replace(/\//g, "\\/"); // Escape slashes

    if (trailingWildcard) {
      regexBody += "(?:/.*?)?";
    }

    const regex = new RegExp(
      `^${regexBody}$`,
      // "s" (dotAll): without it, "." can't match LF/CR/U+2028/U+2029, so a wildcard segment containing one fails to match.
      "is",
    );

    return { verb: verb.toUpperCase(), regex, path };
  }

  /**
   * Normalize path for matching
   *
   * @param path - Raw path from request
   * @returns Normalized path
   */
  private normalizePath(path: string): string {
    const pathWithoutQuery = path.split(/[?#]/)[0];

    // Decode percent-escapes per segment and re-escape any separator the decode
    // yields, so a decoded byte can never create a segment boundary the router
    // did not see. "\" is escaped rather than folded into "/" because routers
    // treat it as an ordinary in-segment character; folding it would split the
    // path into more segments than the router saw and fail open on a :param
    // route whose regex compiles to [^/]+.
    const normalized = pathWithoutQuery
      .split("/")
      .map(segment => {
        let decoded: string;
        try {
          decoded = decodeURIComponent(segment);
        } catch {
          // Malformed escape: match the raw segment rather than widening it.
          return segment;
        }
        return decoded.replace(/\//g, "%2F").replace(/\\/g, "%5C");
      })
      .join("/");

    return normalized.replace(/\/+/g, "/").replace(/(.+?)\/+$/, "$1");
  }

  /**
   * Generate paywall HTML for browser requests
   *
   * @param paymentRequired - Payment required response
   * @param paywallConfig - Optional paywall configuration
   * @param customHtml - Optional custom HTML template
   * @returns HTML string
   */
  private generatePaywallHTML(
    paymentRequired: PaymentRequired,
    paywallConfig?: PaywallConfig,
    customHtml?: string,
  ): string {
    if (customHtml) {
      return customHtml;
    }

    // Use custom paywall provider if set
    if (this.paywallProvider) {
      return this.paywallProvider.generateHtml(paymentRequired, paywallConfig);
    }

    // Try to use @x402/paywall if available (optional dependency)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const paywall = require("@x402/paywall");
      const displayAmount = this.getDisplayAmount(paymentRequired);
      const resource = paymentRequired.resource;

      return paywall.getPaywallHtml({
        amount: displayAmount,
        paymentRequired,
        currentUrl: resource?.url || paywallConfig?.currentUrl || "",
        testnet: paywallConfig?.testnet ?? true,
        appName: paywallConfig?.appName,
        appLogo: paywallConfig?.appLogo,
        sessionTokenEndpoint: paywallConfig?.sessionTokenEndpoint,
      });
    } catch {
      // @x402/paywall not installed, fall back to basic HTML
    }

    return FALLBACK_PAYWALL_HTML;
  }

  /**
   * Extract display amount from payment requirements.
   * Uses the registered scheme's decimal precision for the asset, falling back to 6.
   *
   * @param paymentRequired - The payment required object
   * @returns The display amount in decimal format
   */
  private getDisplayAmount(paymentRequired: PaymentRequired): number {
    const accepts = paymentRequired.accepts;
    if (accepts && accepts.length > 0) {
      const firstReq = accepts[0];
      if ("amount" in firstReq) {
        const decimals = this.ResourceServer.getAssetDecimalsForRequirements(firstReq);
        return parseFloat(firstReq.amount) / 10 ** decimals;
      }
    }
    return 0;
  }
}
