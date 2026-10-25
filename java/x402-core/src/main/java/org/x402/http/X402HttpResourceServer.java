package org.x402.http;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.lang.System.Logger.Level;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.PaymentFlow;
import org.x402.core.SettleException;
import org.x402.core.json.X402Json;
import org.x402.core.server.CompletedSettlement;
import org.x402.core.server.ExtensionValidation;
import org.x402.core.server.FacilitatorCapabilityError;
import org.x402.core.server.FacilitatorRoute;
import org.x402.core.server.PaymentCancellationDispatcher;
import org.x402.core.server.PaymentFlows;
import org.x402.core.server.ResourceConfig;
import org.x402.core.server.ResourceServerExtension;
import org.x402.core.server.RoutingSnapshot;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.ServerVerifyResult;
import org.x402.core.server.SettlementOverrides;
import org.x402.core.server.SettlementRouting;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;

/**
 * The framework-agnostic HTTP resource server: matches routes,
 * answers 402s, verifies payments and settles them, on top of an {@link X402ResourceServer}.
 *
 * <h2>Lifecycle</h2>
 *
 * <p>The constructor checks transfer methods, payment flows and pins. {@link #initialize()} syncs
 * the facilitators, validates every route against the new snapshot (pin, capability, ambiguity and
 * timeout-budget checks), and publishes snapshot and validation together as one {@link
 * HttpServerState} with a single atomic swap. Every request reads that state once and passes its
 * snapshot to every core call, so it never mixes new routing with an old validation result. {@code
 * initialize()} may be called again to re-sync; callers outside Spring should serialize those
 * calls.
 *
 * <p><b>Skip-handler caution.</b> An after-verify hook may skip the handler; the payment is then
 * settled inline <i>after-handler</i>. For {@code upfront} flows (which settle only
 * before the handler) that settles nothing, so the response is served unpaid; a warning is logged.
 * Do not combine skip-handler hooks with upfront flows.
 *
 * <h2>Adapter contract</h2>
 *
 * <ol>
 *   <li>Build an {@link HttpRequestContext} with the raw path within the application ({@code ;}
 *       parameters stripped) and, separately, its decoded form; call {@link
 *       #processHttpRequest}.
 *   <li>{@link HttpProcessResult.NoPaymentRequired}: run the handler normally. {@link
 *       HttpProcessResult.PaymentError}: write its response, do not run the handler. {@link
 *       HttpProcessResult.RouteUnavailable}: answer 503 with {@code Retry-After} when retryable,
 *       else 500. A thrown {@link FacilitatorResponseException}: answer 502.
 *   <li>{@link HttpProcessResult.PaymentVerified}: run the handler with its response buffered.
 *       <ul>
 *         <li>If the handler throws, or answers with status ≥ 400: call {@code
 *             cancellationDispatcher().cancel(...)} (reason {@code handler_threw} / {@code
 *             handler_failed}), set {@link #createFailurePathSettlementHeaders} on the response,
 *             remove {@code Settlement-Overrides}, and do not settle.
 *         <li>Otherwise call {@link #processSettlement(HttpProcessResult.PaymentVerified,
 *             HttpTransportContext)} with the buffered body and response headers ({@code
 *             Settlement-Overrides} is read from them), then remove {@code Settlement-Overrides}.
 *             On {@link ProcessSettleResult.Success} add its headers and {@code Cache-Control}
 *             {@link #withPrivateCacheControl}, then release the body. On {@link
 *             ProcessSettleResult.Failure} discard the body and write its {@code httpResponse}. A
 *             thrown {@link FacilitatorResponseException} means 502.
 *       </ul>
 * </ol>
 */
public final class X402HttpResourceServer {

  /** The {@code Cache-Control} of an unpaid 402. */
  public static final String PAYMENT_REQUIRED_CACHE_CONTROL = "no-store";

  private static final System.Logger LOG =
      System.getLogger(X402HttpResourceServer.class.getName());
  private static final String FALLBACK_PAYWALL = loadFallbackPaywall();
  private static final Map<String, Object> EMPTY_BODY = Map.of();

  private final X402ResourceServer server;
  private final RouteResolver resolver;
  private final RouteValidator validator;
  private final List<ProtectedRequestHook> protectedHooks = new CopyOnWriteArrayList<>();
  private final AtomicReference<HttpServerState> state = new AtomicReference<>();
  private final AtomicBoolean warnedMissingBeforeHandler = new AtomicBoolean();
  private volatile PaywallProvider paywallProvider;

  /**
   * Creates the server and checks what can be checked before any facilitator sync: transfer
   * methods and payment flows of registered schemes, and pins.
   *
   * @param server the core server
   * @param resolver the routes
   * @throws RouteConfigurationError listing every problem found
   */
  public X402HttpResourceServer(X402ResourceServer server, RouteResolver resolver) {
    this.server = Objects.requireNonNull(server, "server");
    this.resolver = Objects.requireNonNull(resolver, "resolver");
    this.validator = new RouteValidator(server, resolver);
    List<RouteValidationError> errors = validator.beforeSync();
    if (!errors.isEmpty()) {
      throw new RouteConfigurationError(errors);
    }
  }

  /**
   * The core server.
   *
   * @return the server
   */
  public X402ResourceServer server() {
    return server;
  }

  /**
   * The route resolver.
   *
   * @return the resolver
   */
  public RouteResolver resolver() {
    return resolver;
  }

  /**
   * Sets the browser paywall renderer.
   *
   * @param provider the provider
   * @return this server
   */
  public X402HttpResourceServer registerPaywallProvider(PaywallProvider provider) {
    this.paywallProvider = provider;
    return this;
  }

  /**
   * Adds a hook that runs before payment processing of every protected request.
   *
   * @param hook the hook
   * @return this server
   */
  public X402HttpResourceServer onProtectedRequest(ProtectedRequestHook hook) {
    protectedHooks.add(Objects.requireNonNull(hook, "hook"));
    return this;
  }

  /**
   * Whether an {@code initialize()} failure is fatal, that is not worth retrying. This includes
   * every {@link RouteConfigurationError}, even one whose {@link
   * RouteConfigurationError#onlyAwaitingFacilitators()} is true. An adapter that re-syncs in the
   * background should check that first and keep retrying instead (the Spring starter does).
   *
   * @param error an {@code initialize()} failure
   * @return {@code true} for {@link FacilitatorCapabilityError} and {@link RouteConfigurationError}
   */
  public static boolean isFatalStartupError(Throwable error) {
    return error instanceof FacilitatorCapabilityError || error instanceof RouteConfigurationError;
  }

  // ---------------------------------------------------------------- initialize

  /**
   * Syncs facilitators sequentially, validates, and publishes the new state.
   *
   * @return the published state
   * @throws RouteConfigurationError when any route is invalid (the state is published first)
   * @throws IllegalStateException when no facilitator listed any kind and every route error is
   *     retryable (not fatal)
   */
  public HttpServerState initialize() {
    return publishValidated(server.sync());
  }

  /**
   * Like {@link #initialize()}, querying facilitators in parallel within a total budget.
   *
   * @param budget the total sync budget
   * @param executor runs the {@code /supported} calls
   * @return the published state
   */
  public HttpServerState initialize(Duration budget, Executor executor) {
    return publishValidated(server.sync(budget, executor));
  }

  /**
   * The currently published state.
   *
   * @return the state, or {@code null} before the first {@link #initialize()}
   */
  public HttpServerState state() {
    return state.get();
  }

  private HttpServerState publishValidated(RoutingSnapshot snapshot) {
    RouteValidator.Result checked = validator.validate(snapshot);
    List<RouteValidationError> errors = checked.errors();
    List<String> warnings = checked.warnings();
    HttpServerState next = new HttpServerState(snapshot, errors, warnings);
    server.publish(snapshot);
    // The state follows the same rule as the core snapshot: an older sync never replaces it.
    state.accumulateAndGet(next,
        (current, candidate) -> current == null
            || current.snapshot().generation() < candidate.snapshot().generation()
            ? candidate : current);
    warnings.forEach(w -> LOG.log(Level.WARNING, w));
    if (errors.stream().anyMatch(e -> !e.retryable())) {
      throw new RouteConfigurationError(errors);
    }
    if (!snapshot.hasKinds()) {
      Throwable last = snapshot.failures().values().stream().reduce((a, b) -> b).orElse(null);
      throw new IllegalStateException(
          "Failed to initialize: no supported payment kinds loaded from any facilitator.", last);
    }
    if (!errors.isEmpty()) {
      throw new RouteConfigurationError(errors);
    }
    return next;
  }

  // ---------------------------------------------------------------- requests

  /**
   * Whether a request needs payment (a route matches).
   *
   * @param context the request
   * @return {@code true} when a route matches
   */
  public boolean requiresPayment(HttpRequestContext context) {
    return resolver.resolve(withMethod(context)) != null;
  }

  /**
   * Processes a request without paywall options.
   *
   * @param context the request
   * @return the result
   * @see #processHttpRequest(HttpRequestContext, PaywallConfig)
   */
  public HttpProcessResult processHttpRequest(HttpRequestContext context) {
    return processHttpRequest(context, null);
  }

  /**
   * Processes a request: route match, protected-request hooks, 402 for
   * unpaid requests (paywall HTML for browsers), then match, extension echo check, verify, and
   * for upfront/escrow flows settle before the handler.
   *
   * @param context the request
   * @param paywallConfig paywall options, may be {@code null}
   * @return the result
   * @throws FacilitatorResponseException on a facilitator transport failure (adapter: 502)
   * @throws IllegalStateException when a protected route is hit before {@link #initialize()}
   */
  public HttpProcessResult processHttpRequest(
      HttpRequestContext context, PaywallConfig paywallConfig) {
    HttpRequestContext ctx = withMethod(context);
    RouteMatch match = resolver.resolve(ctx);
    if (match == null) {
      return new HttpProcessResult.NoPaymentRequired();
    }
    HttpServerState current = state.get();
    if (current == null) {
      throw new IllegalStateException("x402: call initialize() before serving protected routes");
    }
    List<RouteValidationError> routeErrors = current.errorsFor(match.key());
    if (!routeErrors.isEmpty()) {
      return new HttpProcessResult.RouteUnavailable(match.key(), routeErrors,
          routeErrors.stream().allMatch(RouteValidationError::retryable));
    }
    RoutingSnapshot snapshot = current.snapshot();
    HttpRequestContext request = ctx.withRoutePattern(match.pattern());
    RouteConfig config = match.config();
    for (ProtectedRequestHook hook : protectedHooks(config)) {
      ProtectedRequestHook.Result result = hook.apply(request, config);
      if (result instanceof ProtectedRequestHook.GrantAccess) {
        return new HttpProcessResult.NoPaymentRequired();
      }
      if (result instanceof ProtectedRequestHook.Abort abort) {
        return new HttpProcessResult.PaymentError(new HttpResponseInstructions(403,
            Map.of("Content-Type", "application/json"), Map.of("error", abort.reason()), false));
      }
    }
    PaymentPayload payload = extractPayment(request.adapter());
    ResourceInfo resource = new ResourceInfo(
        config.resource() != null && !config.resource().isEmpty() ? config.resource()
            : request.url(),
        config.description() == null ? "" : config.description(),
        config.mimeType() == null ? "" : config.mimeType(),
        config.serviceName(), config.tags(), config.iconUrl());
    List<PaymentRequirements> requirements = new ArrayList<>();
    for (PaymentOption option : config.accepts()) {
      ResourceConfig resolved = option.resolve(request);
      requirements.addAll(server.buildPaymentRequirements(resolved, snapshot));
    }
    Map<String, Object> extensions = config.extensions() == null ? null
        : server.enrichExtensions(config.extensions(), request);
    HttpTransportContext transport = new HttpTransportContext(request, null, null);
    // Scheme enrichment gets the paid payload explicitly on every paid-path 402.
    PaymentRequired required = server.createPaymentRequiredResponse(requirements, resource,
        payload == null ? "Payment required" : null, extensions, transport, payload);
    if (payload == null) {
      HttpResponseBody unpaid = config.unpaidResponseBody() == null ? null
          : config.unpaidResponseBody().create(request);
      return new HttpProcessResult.PaymentError(createHttpResponse(required,
          isWebBrowser(request.adapter()), paywallConfig, config.customPaywallHtml(), unpaid));
    }
    try {
      PaymentRequirements matching = server.findMatchingRequirements(required.accepts(), payload);
      if (matching == null) {
        return error402(requirements, resource, "No matching payment requirements", extensions,
            transport, payload, paywallConfig);
      }
      ExtensionValidation echo = server.validateExtensions(required, payload);
      if (!echo.valid()) {
        return error402(requirements, resource, echo.invalidReason(), extensions, transport,
            payload, paywallConfig);
      }
      PaymentOption option = config.accepts().get(indexOf(required.accepts(), matching));
      FacilitatorRoute route = FacilitatorRoute.of(option.facilitator(), config.failover());
      PaymentFlow flow = server.getPaymentFlow(payload, matching);
      ServerVerifyResult verified = server.verifyPayment(payload, matching, extensions,
          transport, route, snapshot);
      if (!verified.isValid()) {
        return error402(requirements, resource, verified.response().invalidReason(), extensions,
            transport, payload, paywallConfig);
      }
      SettlementRouting routing = new SettlementRouting(route, verified.verifiedBy(), snapshot);
      if (verified.skipHandler() != null) {
        return skipHandler(payload, matching, extensions, transport, routing, verified, flow);
      }
      CompletedSettlement before = null;
      if (flow.settleBeforeHandler()) {
        ProcessSettleResult result = processSettlement(payload, matching, extensions, transport,
            null, null, SettlePhase.BEFORE_HANDLER, routing);
        if (result instanceof ProcessSettleResult.Failure failure) {
          return new HttpProcessResult.PaymentError(failure.httpResponse());
        }
        ProcessSettleResult.Success success = (ProcessSettleResult.Success) result;
        before = new CompletedSettlement(SettlePhase.BEFORE_HANDLER, flow, success.response(),
            success.requirements());
      }
      PaymentCancellationDispatcher dispatcher = server.createPaymentCancellationDispatcher(
          payload, matching, extensions, transport,
          before != null ? List.of(SettlePhase.BEFORE_HANDLER) : List.of(), routing);
      return new HttpProcessResult.PaymentVerified(payload, matching, extensions, before,
          dispatcher, routing, match.key());
    } catch (FacilitatorResponseException e) {
      throw e;
    } catch (RuntimeException e) {
      return error402(requirements, resource,
          e.getMessage() == null ? "Payment verification failed" : e.getMessage(), extensions,
          transport, payload, paywallConfig);
    }
  }

  private HttpProcessResult error402(List<PaymentRequirements> requirements,
      ResourceInfo resource, String error, Map<String, Object> extensions,
      HttpTransportContext transport, PaymentPayload payload, PaywallConfig paywallConfig) {
    PaymentRequired response = server.createPaymentRequiredResponse(requirements, resource, error,
        extensions, transport, payload);
    return new HttpProcessResult.PaymentError(
        createHttpResponse(response, false, paywallConfig, null, null));
  }

  private static int indexOf(List<PaymentRequirements> accepts, PaymentRequirements matching) {
    for (int i = 0; i < accepts.size(); i++) {
      if (accepts.get(i) == matching) {
        return i;
      }
    }
    return accepts.indexOf(matching);
  }

  private HttpProcessResult skipHandler(PaymentPayload payload, PaymentRequirements requirements,
      Map<String, Object> extensions, HttpTransportContext transport, SettlementRouting routing,
      ServerVerifyResult verified, PaymentFlow flow) {
    if (!flow.settleAfterHandler()) {
      LOG.log(Level.WARNING, "[x402] skipHandler on payment flow \"" + flow.wire()
          + "\": the payment was not settled (skipping the handler settles only on flows that "
          + "settle after the handler, and this flow settles before it)");
    }
    ProcessSettleResult result = processSettlement(payload, requirements, extensions, transport,
        null, null, SettlePhase.AFTER_HANDLER, routing);
    if (result instanceof ProcessSettleResult.Failure failure) {
      return new HttpProcessResult.PaymentError(failure.httpResponse());
    }
    String contentType = verified.skipHandler().contentType() != null
        ? verified.skipHandler().contentType() : "application/json";
    Object body = verified.skipHandler().body() != null ? verified.skipHandler().body()
        : EMPTY_BODY;
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put("Content-Type", contentType);
    headers.putAll(result.headers());
    headers.put("Cache-Control", withPrivateCacheControl(null));
    return new HttpProcessResult.PaymentError(new HttpResponseInstructions(200, headers, body,
        contentType.contains("text/html")));
  }

  private List<ProtectedRequestHook> protectedHooks(RouteConfig config) {
    List<ProtectedRequestHook> hooks = new ArrayList<>(protectedHooks);
    Map<String, Object> declared = config.extensions();
    if (declared == null) {
      return hooks;
    }
    for (ResourceServerExtension extension : server.getExtensions()) {
      if (extension instanceof HttpResourceServerExtension http
          && declared.containsKey(extension.key())) {
        Object declaration = declared.get(extension.key());
        hooks.add((ctx, route) -> http.onProtectedRequest(declaration, ctx, route));
      }
    }
    return hooks;
  }

  private static PaymentPayload extractPayment(HttpAdapter adapter) {
    String header = adapter.getHeader(X402Headers.PAYMENT_SIGNATURE);
    if (header == null || header.isEmpty()) {
      return null;
    }
    try {
      return HeaderCodec.decodePaymentSignature(header);
    } catch (IllegalArgumentException e) {
      LOG.log(Level.WARNING, "[x402] Failed to decode PAYMENT-SIGNATURE header: "
          + e.getMessage());
      return null;
    }
  }

  private static boolean isWebBrowser(HttpAdapter adapter) {
    return adapter.getAcceptHeader().contains("text/html")
        && adapter.getUserAgent().contains("Mozilla");
  }

  private HttpResponseInstructions createHttpResponse(PaymentRequired required, boolean browser,
      PaywallConfig paywallConfig, String customHtml, HttpResponseBody unpaid) {
    int status = "permit2_allowance_required".equals(required.error()) ? 412 : 402;
    Map<String, String> headers = new LinkedHashMap<>();
    if (browser) {
      headers.put("Content-Type", "text/html");
      headers.put(X402Headers.PAYMENT_REQUIRED, HeaderCodec.encodePaymentRequired(required));
      headers.put("Cache-Control", PAYMENT_REQUIRED_CACHE_CONTROL);
      return new HttpResponseInstructions(status, headers,
          paywallHtml(required, paywallConfig, customHtml), true);
    }
    headers.put("Content-Type", unpaid != null ? unpaid.contentType() : "application/json");
    headers.put(X402Headers.PAYMENT_REQUIRED, HeaderCodec.encodePaymentRequired(required));
    headers.put("Cache-Control", PAYMENT_REQUIRED_CACHE_CONTROL);
    return new HttpResponseInstructions(status, headers, unpaid != null ? unpaid.body()
        : EMPTY_BODY, false);
  }

  private String paywallHtml(PaymentRequired required, PaywallConfig config, String custom) {
    if (custom != null) {
      return custom;
    }
    PaywallProvider provider = paywallProvider;
    return provider != null ? provider.generateHtml(required, config) : FALLBACK_PAYWALL;
  }

  private static String loadFallbackPaywall() {
    try (InputStream in = X402HttpResourceServer.class.getResourceAsStream(
        "/org/x402/http/fallback-paywall.html")) {
      return new String(Objects.requireNonNull(in, "fallback paywall").readAllBytes(),
          StandardCharsets.UTF_8);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static HttpRequestContext withMethod(HttpRequestContext context) {
    return context.method() != null ? context
        : context.withMethod(context.adapter().getMethod());
  }

  // ---------------------------------------------------------------- settlement

  /**
   * Settles a verified payment after the handler, with the facilitator routing it was verified
   * with (settle and the pending retry go to {@code verifiedBy}, else the pin, else the build
   * facilitator).
   *
   * @param verified the result of {@link #processHttpRequest}
   * @param transport the request with the handler's buffered body and response headers
   * @return the result
   * @throws FacilitatorResponseException on a facilitator transport failure (adapter: 502)
   */
  public ProcessSettleResult processSettlement(
      HttpProcessResult.PaymentVerified verified, HttpTransportContext transport) {
    return processSettlement(verified.paymentPayload(), verified.paymentRequirements(),
        verified.declaredExtensions(), transport, null, verified.beforeHandlerSettlement(), null,
        verified.routing());
  }

  /**
   * Processes the settlement of a verified payment. Flows that do not settle after the handler
   * echo the before-handler settlement. {@code Settlement-Overrides} is read from the response
   * headers when no overrides are given; a malformed value is ignored.
   *
   * @param payload the payment
   * @param requirements the requirements
   * @param declaredExtensions the declarations, may be {@code null}
   * @param transport the transport context, may be {@code null}
   * @param overrides explicit overrides, may be {@code null}
   * @param beforeHandlerSettlement the before-handler settlement, may be {@code null}
   * @param phase the phase, {@code null} for after-handler
   * @param routing where to settle
   * @return the result
   * @throws FacilitatorResponseException on a facilitator transport failure
   */
  public ProcessSettleResult processSettlement(
      PaymentPayload payload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      HttpTransportContext transport,
      SettlementOverrides overrides,
      CompletedSettlement beforeHandlerSettlement,
      SettlePhase phase,
      SettlementRouting routing) {
    PaymentFlow flow = beforeHandlerSettlement != null ? beforeHandlerSettlement.flow()
        : server.getPaymentFlow(payload, requirements);
    if (phase != SettlePhase.BEFORE_HANDLER && !flow.settleAfterHandler()) {
      if (beforeHandlerSettlement != null) {
        return new ProcessSettleResult.Success(beforeHandlerSettlement.result(),
            createSettlementHeaders(beforeHandlerSettlement.result()),
            beforeHandlerSettlement.requirements());
      }
      if (flow.settleBeforeHandler() && warnedMissingBeforeHandler.compareAndSet(false, true)) {
        LOG.log(Level.WARNING, "[x402] Payment flow \"" + flow.wire() + "\" settles before the "
            + "handler, but processSettlement was called without beforeHandlerSettlement from "
            + "processHttpRequest. Skipping after-handler settle. Pass that settle result to echo "
            + "the before-handler PAYMENT-RESPONSE.");
      }
      return new ProcessSettleResult.Success(SettleResponse.success("", requirements.network(),
          null), Map.of(), requirements);
    }
    SettlePhase resolvedPhase = phase == null ? SettlePhase.AFTER_HANDLER : phase;
    try {
      SettlementOverrides resolved = overrides != null ? overrides : overridesFrom(transport);
      SettleResponse response = server.settlePayment(payload, requirements, declaredExtensions,
          transport, resolved, resolvedPhase,
          routing == null ? SettlementRouting.auto() : routing);
      if (!response.success()) {
        String reason = response.errorReason() == null || response.errorReason().isEmpty()
            ? "Settlement failed" : response.errorReason();
        String message = response.errorMessage() == null || response.errorMessage().isEmpty()
            ? reason : response.errorMessage();
        SettleResponse failure = new SettleResponse(false, reason, message, response.payer(),
            response.transaction(), response.network(), response.amount(), response.extensions(),
            response.extensionResponses(), response.extra());
        return failure(failure, createSettlementHeaders(response), transport);
      }
      return new ProcessSettleResult.Success(response, createSettlementHeaders(response),
          requirements);
    } catch (FacilitatorResponseException e) {
      throw e;
    } catch (SettleException e) {
      String reason = e.response().errorReason() == null ? e.getMessage()
          : e.response().errorReason();
      String message = e.response().errorMessage() == null ? reason : e.response().errorMessage();
      SettleResponse failure = new SettleResponse(false, reason, message, e.response().payer(),
          e.response().transaction() == null ? "" : e.response().transaction(),
          e.response().network(), null, null, null, null);
      return failure(failure, createSettlementHeaders(failure), transport);
    } catch (RuntimeException e) {
      String reason = e.getMessage() == null ? "Settlement failed" : e.getMessage();
      SettleResponse failure = new SettleResponse(false, reason, reason, null, "",
          requirements.network(), null, null, null, null);
      return failure(failure, createSettlementHeaders(failure), transport);
    }
  }

  private static SettlementOverrides overridesFrom(HttpTransportContext transport) {
    if (transport == null || transport.responseHeaders() == null) {
      return null;
    }
    String key = X402Headers.SETTLEMENT_OVERRIDES.toLowerCase(Locale.ROOT);
    String raw = transport.responseHeaders().entrySet().stream()
        .filter(e -> e.getKey() != null && e.getKey().toLowerCase(Locale.ROOT).equals(key))
        .map(Map.Entry::getValue).findFirst().orElse(null);
    if (raw == null || raw.isEmpty()) {
      return null;
    }
    try {
      return X402Json.read(raw, SettlementOverrides.class);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }

  private ProcessSettleResult failure(SettleResponse failure, Map<String, String> headers,
      HttpTransportContext transport) {
    HttpResponseBody custom = null;
    if (transport != null && transport.request() != null) {
      RouteMatch match = resolver.resolve(withMethod(transport.request()));
      if (match != null && match.config().settlementFailedResponseBody() != null) {
        custom = match.config().settlementFailedResponseBody().create(transport.request(),
            failure);
      }
    }
    String contentType = custom != null ? custom.contentType() : "application/json";
    Map<String, String> responseHeaders = new LinkedHashMap<>();
    responseHeaders.put("Content-Type", contentType);
    responseHeaders.putAll(headers);
    responseHeaders.put("Cache-Control", PAYMENT_REQUIRED_CACHE_CONTROL);
    return new ProcessSettleResult.Failure(failure, headers, new HttpResponseInstructions(402,
        responseHeaders, custom != null ? custom.body() : EMPTY_BODY,
        contentType.contains("text/html")));
  }

  /**
   * Creates the {@code PAYMENT-RESPONSE} header.
   *
   * @param response the settlement
   * @return the headers
   */
  public Map<String, String> createSettlementHeaders(SettleResponse response) {
    return Map.of(X402Headers.PAYMENT_RESPONSE, HeaderCodec.encodePaymentResponse(response));
  }

  /**
   * The receipt of a completed settle plus a private
   * {@code Cache-Control}.
   *
   * @param settlement the settlement
   * @param existingCacheControl the response's {@code Cache-Control}, may be {@code null}
   * @return the headers
   */
  public Map<String, String> createCompletedSettlementHeaders(
      CompletedSettlement settlement, String existingCacheControl) {
    Map<String, String> headers = new LinkedHashMap<>(createSettlementHeaders(settlement.result()));
    headers.put("Cache-Control", withPrivateCacheControl(existingCacheControl));
    return headers;
  }

  /**
   * The receipt to send when the handler
   * failed after the payment was verified (cancel result, else the before-handler settlement).
   *
   * @param cancelSettlement the cancel dispatcher's result, may be {@code null}
   * @param beforeHandlerSettlement the before-handler settlement, may be {@code null}
   * @param payload the payment, for escrow recovery fields
   * @param existingCacheControl the response's {@code Cache-Control}, may be {@code null}
   * @return the headers, or {@code null} when there is no receipt
   */
  public Map<String, String> createFailurePathSettlementHeaders(
      SettleResponse cancelSettlement, CompletedSettlement beforeHandlerSettlement,
      PaymentPayload payload, String existingCacheControl) {
    SettleResponse receipt = PaymentFlows.resolveFailurePathSettlement(cancelSettlement,
        beforeHandlerSettlement, payload);
    if (receipt == null) {
      return null;
    }
    Map<String, String> headers = new LinkedHashMap<>(createSettlementHeaders(receipt));
    headers.put("Cache-Control", withPrivateCacheControl(existingCacheControl));
    return headers;
  }

  /**
   * Adds {@code private} unless present.
   *
   * @param value the current {@code Cache-Control}, may be {@code null}
   * @return the value with {@code private}
   */
  public static String withPrivateCacheControl(String value) {
    if (value == null || value.isEmpty()) {
      return "private";
    }
    for (String directive : value.split(",", -1)) {
      if (directive.strip().toLowerCase(Locale.ROOT).equals("private")) {
        return value;
      }
    }
    return value + ", private";
  }
}
