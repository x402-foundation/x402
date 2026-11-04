package org.x402.http;

import org.x402.Network;
import org.x402.SettleException;
import org.x402.X402;
import org.x402.X402Exception;
import org.x402.X402ResourceServer;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.util.Json;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;

/**
 * Framework-independent HTTP payment processing for a resource server, mirroring {@code x402HTTPResourceServer}
 * in {@code go/http/server.go}. Framework adapters such as
 * {@link org.x402.http.servlet.PaymentFilter} call {@link #processRequest} before the protected handler and
 * {@link #processSettlement} after it.
 *
 * <p>Routes map a pattern to a {@link RouteConfig}:
 *
 * <pre>{@code
 * Map<String, RouteConfig> routes = new LinkedHashMap<>();
 * routes.put("GET /weather", weatherRoute);         // GET only; HEAD falls back to it
 * routes.put("/reports/*", reportsRoute);           // any method except OPTIONS, any depth below /reports
 * routes.put("POST /users/:id/export", exportRoute); // :id and [id] match one path segment
 *
 * HttpResourceServer server = new HttpResourceServer(resourceServer, routes);
 * server.initialize();
 * }</pre>
 *
 * <p>Routes are tried in the map's iteration order and the first match wins, so use an ordered map when
 * patterns overlap. Paths are matched case-sensitively after normalization; see {@link HttpRequestAdapter} for
 * the paths an adapter supplies. The raw and the decoded path are each matched as normalized and in the
 * canonical form a servlet container dispatches on (dot segments resolved, {@code ;} parameters removed). A
 * request whose forms match different routes is rejected, so that with a free {@code /public/*} and a paid
 * {@code /premium}, {@code /public/../premium} cannot reach {@code /premium} for free.
 *
 * <p>{@link #processRequest} answers as follows:
 *
 * <table>
 *   <caption>Request outcomes</caption>
 *   <tr><th>Condition</th><th>Result</th></tr>
 *   <tr><td>The path's forms match different routes</td>
 *       <td>400 {@code {"error":"invalid_path"}}</td></tr>
 *   <tr><td>No route matches, or the route has no options and no extensions</td>
 *       <td>{@link ProcessResult.NoPaymentRequired}</td></tr>
 *   <tr><td>{@link #initialize()} has not succeeded and cannot complete for this request, see
 *       {@link #processRequest}</td>
 *       <td>503 {@code {"error":"facilitator_unavailable"}}, or 500 for a route configuration error</td></tr>
 *   <tr><td>{@code PAYMENT-SIGNATURE} is not base64 JSON of a v2 payload with a CAIP-2 {@code accepted.network}</td>
 *       <td>400 {@code {"error":"invalid_payload"}}</td></tr>
 *   <tr><td>The route's requirements cannot be built</td>
 *       <td>500 {@code {"error":"Internal Server Error"}}</td></tr>
 *   <tr><td>No {@code PAYMENT-SIGNATURE}</td>
 *       <td>402, error {@value #PAYMENT_REQUIRED_ERROR}</td></tr>
 *   <tr><td>{@code accepted} matches none of the requirements</td>
 *       <td>402, error {@value #NO_MATCHING_REQUIREMENTS_ERROR}</td></tr>
 *   <tr><td>Verification fails</td>
 *       <td>402, error is the failure reason, e.g. {@code invalid_exact_evm_signature}</td></tr>
 *   <tr><td>The facilitator cannot be reached</td>
 *       <td>402, error is the {@link IOException} message</td></tr>
 *   <tr><td>The payment is valid</td>
 *       <td>{@link ProcessResult.PaymentVerified}</td></tr>
 * </table>
 *
 * <p>Every 402 carries {@code Content-Type: application/json}, a {@code PAYMENT-REQUIRED} header holding the
 * base64 {@link PaymentRequired} message, {@code Cache-Control: no-store} and the body
 * {@code {"error":"<error>"}}.
 *
 * <p>Instances are thread-safe.
 */
public final class HttpResourceServer {

    /** Error body of a 400 response to a malformed {@code PAYMENT-SIGNATURE} header. */
    public static final String INVALID_PAYLOAD = "invalid_payload";

    /** Error body of a 400 response to a request whose path forms match different routes. */
    public static final String INVALID_PATH = "invalid_path";

    /** Error body of a 503 response to a paid request while facilitator support cannot be fetched. */
    public static final String FACILITATOR_UNAVAILABLE = "facilitator_unavailable";

    /** Error body of a 402 response when settlement fails. */
    public static final String SETTLEMENT_FAILED = "settlement_failed";

    /** {@code PaymentRequired.error} when the request carries no payment. */
    public static final String PAYMENT_REQUIRED_ERROR = "Payment required";

    /** {@code PaymentRequired.error} when the payment matches none of the route's requirements. */
    public static final String NO_MATCHING_REQUIREMENTS_ERROR = "No matching payment requirements";

    /** {@code Cache-Control} value of every 402 response. */
    public static final String NO_STORE = "no-store";

    private static final System.Logger LOG = System.getLogger(HttpResourceServer.class.getName());

    private static final String CONTENT_TYPE = "Content-Type";
    private static final String CACHE_CONTROL = "Cache-Control";
    private static final String APPLICATION_JSON = "application/json";
    private static final String PRIVATE = "private";
    private static final String PAYMENT_FLOW = "paymentFlow";
    private static final String AUTHORIZATION_FLOW = "authorization";
    private static final ProcessResult NO_PAYMENT_REQUIRED = new ProcessResult.NoPaymentRequired();
    private static final long INITIALIZATION_RETRY_NANOS = TimeUnit.SECONDS.toNanos(5);

    private final X402ResourceServer resourceServer;
    private final RouteMatcher routes;
    private final LongSupplier nanoTime;
    private final ReentrantLock initializationLock = new ReentrantLock();
    private volatile boolean initialized;
    // Guarded by initializationLock: the answer of the last failed request-time initialization, and when to retry.
    private ProcessResult initializationFailure;
    private long initializationRetryNanos;

    /**
     * Creates an HTTP resource server.
     *
     * @param resourceServer the transport-independent resource server
     * @param routes route configurations keyed by pattern, tried in the map's iteration order
     * @throws IllegalArgumentException if a pattern is blank, has more than two parts, or has an invalid method
     */
    public HttpResourceServer(X402ResourceServer resourceServer, Map<String, RouteConfig> routes) {
        this(resourceServer, routes, System::nanoTime);
    }

    /** Creates a server whose initialization retry interval is measured with {@code nanoTime}. */
    HttpResourceServer(X402ResourceServer resourceServer, Map<String, RouteConfig> routes, LongSupplier nanoTime) {
        this.resourceServer = Objects.requireNonNull(resourceServer, "resourceServer");
        this.routes = new RouteMatcher(Objects.requireNonNull(routes, "routes"));
        this.nanoTime = Objects.requireNonNull(nanoTime, "nanoTime");
    }

    /**
     * Returns the underlying transport-independent resource server.
     *
     * @return the resource server
     */
    public X402ResourceServer resourceServer() {
        return resourceServer;
    }

    /**
     * Initializes facilitator support and validates every route. Each payment option must have a registered
     * scheme server, ask for no payment flow other than {@code authorization}, and be supported by a facilitator.
     * The requirements of every option are also built once, so a price or {@code extra} the scheme server
     * rejects, such as an unsupported {@code assetTransferMethod}, fails here rather than on every request.
     *
     * @throws IOException if a facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     * @throws RouteConfigurationException listing every route problem found
     */
    public void initialize() throws IOException, InterruptedException {
        resourceServer.initialize();
        List<RouteConfigurationException.Problem> problems = validateRoutes();
        if (!problems.isEmpty()) {
            throw new RouteConfigurationException(problems);
        }
        initialized = true;
    }

    /**
     * Returns whether {@link #initialize()} has completed successfully.
     *
     * @return {@code true} once facilitator support is known and every route is valid
     */
    public boolean isInitialized() {
        return initialized;
    }

    /**
     * Returns whether a request matches a route, without decoding or verifying any payment.
     *
     * @param request the request
     * @return {@code true} if a route matches the request's method and path, including a route without options
     *     and a path whose forms match different routes
     */
    public boolean requiresPayment(HttpRequestAdapter request) {
        Objects.requireNonNull(request, "request");
        return !findRoute(request).routes().isEmpty();
    }

    /**
     * Decides how to answer a request before the protected handler runs. See the class documentation for the
     * outcomes.
     *
     * <p>If {@link #initialize()} has not succeeded, a request to a paid route runs it first. One request at a
     * time runs it; paid requests arriving meanwhile get the 503. When it fails, the failure is logged and, for 5
     * seconds after the attempt ends, paid requests get the same answer without contacting the facilitator: the
     * 503 if a facilitator cannot be reached, a 500 for a route configuration error.
     *
     * <p>When the thread is interrupted, the interrupt flag is restored and a 402 or 503 is returned.
     *
     * @param request the request
     * @return the outcome
     */
    public ProcessResult processRequest(HttpRequestAdapter request) {
        Objects.requireNonNull(request, "request");
        RouteMatcher.Match routeMatch = findRoute(request);
        if (routeMatch.ambiguous()) {
            return new ProcessResult.PaymentError(errorResponse(400, INVALID_PATH));
        }
        Optional<RouteMatcher.Route> match = routeMatch.route();
        if (match.isEmpty()) {
            return NO_PAYMENT_REQUIRED;
        }
        RouteConfig route = match.get().config();
        if (route.accepts().isEmpty() && (route.extensions() == null || route.extensions().isEmpty())) {
            return NO_PAYMENT_REQUIRED;
        }
        if (!initialized) {
            Optional<ProcessResult> notReady = initializeForRequest();
            if (notReady.isPresent()) {
                return notReady.get();
            }
        }

        Optional<PaymentPayload> payload;
        try {
            payload = extractPayment(request);
        } catch (IllegalArgumentException e) {
            return new ProcessResult.PaymentError(errorResponse(400, INVALID_PAYLOAD));
        }

        List<PaymentRequirements> requirements;
        try {
            requirements = buildRequirements(route);
        } catch (RuntimeException e) {
            LOG.log(System.Logger.Level.WARNING, "Failed to build payment requirements for "
                    + match.get().pattern(), e);
            return new ProcessResult.PaymentError(errorResponse(500, "Internal Server Error"));
        }

        ResourceInfo resource = ResourceInfo.of(
                route.resource() != null ? route.resource() : request.url(), route.description(), route.mimeType());
        Map<String, Object> extensions = route.extensions();
        if (payload.isEmpty()) {
            return paymentRequired(requirements, resource, PAYMENT_REQUIRED_ERROR, extensions);
        }

        Optional<PaymentRequirements> matched = resourceServer.findMatchingRequirements(requirements, payload.get());
        if (matched.isEmpty()) {
            return paymentRequired(requirements, resource, NO_MATCHING_REQUIREMENTS_ERROR, extensions);
        }

        try {
            resourceServer.verify(payload.get(), matched.get(), extensions);
        } catch (X402Exception e) {
            return paymentRequired(requirements, resource, reasonOf(e), extensions);
        } catch (IOException e) {
            LOG.log(System.Logger.Level.WARNING, "Facilitator verify failed", e);
            return paymentRequired(requirements, resource, describe(e), extensions);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return paymentRequired(requirements, resource, describe(e), extensions);
        }
        return new ProcessResult.PaymentVerified(payload.get(), matched.get());
    }

    /**
     * Settles a verified payment after the protected handler succeeded. Call it only when the handler's status
     * is below 400; otherwise skip settlement and release the handler's response.
     *
     * <p>Any failure yields {@link SettlementResult.Failed}, whose response must replace the buffered one: a
     * failed settle response from the facilitator is forwarded with its receipt, a thrown
     * {@link SettleException} keeps its transaction only for {@code settlement_pending}, and the message of any
     * other exception, including an unchecked one from the facilitator client, becomes the error reason. When the
     * thread is interrupted, the interrupt flag is restored and settlement fails.
     *
     * @param verified the result of {@link #processRequest} for this request
     * @return the settlement outcome
     */
    public SettlementResult processSettlement(ProcessResult.PaymentVerified verified) {
        Objects.requireNonNull(verified, "verified");
        PaymentRequirements requirements = verified.requirements();
        SettleResponse response;
        try {
            response = resourceServer.settle(verified.payload(), requirements);
        } catch (SettleException e) {
            return settlementFailure(new SettleResponse(false, reasonOf(e), e.errorMessage(), e.payer(),
                    sanitizedTransaction(e.reason(), e.transaction()), networkOr(e.network(), requirements),
                    null, null, null));
        } catch (X402Exception e) {
            return settlementFailure(failureReceipt(reasonOf(e), null, requirements));
        } catch (IOException | RuntimeException e) {
            LOG.log(System.Logger.Level.WARNING, "Facilitator settle failed", e);
            return settlementFailure(failureReceipt(describe(e), null, requirements));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return settlementFailure(failureReceipt(describe(e), null, requirements));
        }

        if (!response.success()) {
            return settlementFailure(new SettleResponse(false, response.errorReason(), response.errorMessage(),
                    response.payer(), response.transaction() == null ? "" : response.transaction(),
                    networkOr(response.network(), requirements), response.amount(), null, response.extra()));
        }
        try {
            return new SettlementResult.Settled(
                    response, Map.of(PaymentHeaders.PAYMENT_RESPONSE, PaymentHeaders.encode(response)));
        } catch (IllegalArgumentException e) {
            LOG.log(System.Logger.Level.WARNING, "Cannot encode the PAYMENT-RESPONSE header", e);
            return settlementFailure(failureReceipt(
                    "failed to create settlement headers: " + e.getMessage(), response.payer(), requirements));
        }
    }

    /**
     * Adds the {@code private} directive to a {@code Cache-Control} value so shared caches do not store a paid
     * response, keeping the handler's directives.
     *
     * @param existing the handler's {@code Cache-Control} value, or {@code null}
     * @return {@code "private"} when {@code existing} is empty, {@code existing} when it already has a
     *     {@code private} directive (any case), otherwise {@code existing + ", private"}
     */
    public static String withPrivateCacheControl(String existing) {
        if (existing == null || existing.isEmpty()) {
            return PRIVATE;
        }
        for (String directive : existing.split(",")) {
            if (directive.trim().equalsIgnoreCase(PRIVATE)) {
                return existing;
            }
        }
        return existing + ", " + PRIVATE;
    }

    private RouteMatcher.Match findRoute(HttpRequestAdapter request) {
        return routes.match(request.method(), request.path(), request.decodedPath().orElse(null));
    }

    /**
     * Runs {@link #initialize()} for a paid request that arrived before it succeeded.
     *
     * @return empty once initialized, otherwise the response to send instead
     */
    private Optional<ProcessResult> initializeForRequest() {
        if (!initializationLock.tryLock()) {
            return Optional.of(facilitatorUnavailable());
        }
        try {
            if (initialized) {
                return Optional.empty();
            }
            if (initializationFailure != null && nanoTime.getAsLong() - initializationRetryNanos < 0) {
                return Optional.of(initializationFailure);
            }
            try {
                initialize();
                return Optional.empty();
            } catch (IOException e) {
                LOG.log(System.Logger.Level.WARNING,
                        "x402 initialization failed; the next paid request after 5 seconds retries it", e);
                return Optional.of(initializationFailed(facilitatorUnavailable()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return Optional.of(facilitatorUnavailable());
            } catch (RuntimeException e) {
                LOG.log(System.Logger.Level.ERROR, "x402 initialization failed", e);
                return Optional.of(initializationFailed(
                        new ProcessResult.PaymentError(errorResponse(500, "Internal Server Error"))));
            }
        } finally {
            initializationLock.unlock();
        }
    }

    /** Remembers the answer to give paid requests for the 5 seconds after a failed attempt ends. */
    private ProcessResult initializationFailed(ProcessResult answer) {
        initializationFailure = answer;
        initializationRetryNanos = nanoTime.getAsLong() + INITIALIZATION_RETRY_NANOS;
        return answer;
    }

    private static ProcessResult facilitatorUnavailable() {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put(CONTENT_TYPE, APPLICATION_JSON);
        headers.put(CACHE_CONTROL, NO_STORE);
        return new ProcessResult.PaymentError(
                new HttpResponseInstructions(503, headers, errorBody(FACILITATOR_UNAVAILABLE)));
    }

    private List<RouteConfigurationException.Problem> validateRoutes() {
        List<RouteConfigurationException.Problem> problems = new ArrayList<>();
        for (RouteMatcher.Route route : routes.routes()) {
            for (PaymentOption option : route.config().accepts()) {
                String prefix = "Route \"" + route.pattern() + "\": ";
                if (resourceServer.schemeServer(option.network(), option.scheme()).isEmpty()) {
                    problems.add(problem(route, option, RouteConfigurationException.MISSING_SCHEME, prefix
                            + "No scheme implementation registered for \"" + option.scheme() + "\" on network \""
                            + option.network() + "\""));
                    continue;
                }
                int found = problems.size();
                Object flow = option.extra() == null ? null : option.extra().get(PAYMENT_FLOW);
                if (flow != null && !AUTHORIZATION_FLOW.equals(flow)) {
                    problems.add(problem(route, option, RouteConfigurationException.UNSUPPORTED_PAYMENT_FLOW, prefix
                            + "Unsupported paymentFlow \"" + flow + "\"; only \"" + AUTHORIZATION_FLOW
                            + "\" is supported"));
                }
                if (!resourceServer.hasFacilitatorSupport(option.network(), option.scheme())) {
                    problems.add(problem(route, option, RouteConfigurationException.MISSING_FACILITATOR, prefix
                            + "Facilitator does not support scheme \"" + option.scheme() + "\" on network \""
                            + option.network() + "\""));
                }
                if (problems.size() == found) {
                    try {
                        resourceServer.buildPaymentRequirements(option.toResourceConfig());
                    } catch (RuntimeException e) {
                        problems.add(problem(route, option, RouteConfigurationException.INVALID_PAYMENT_OPTION,
                                prefix + "Cannot build payment requirements: " + describe(e)));
                    }
                }
            }
        }
        return problems;
    }

    private static RouteConfigurationException.Problem problem(
            RouteMatcher.Route route, PaymentOption option, String reason, String message) {
        return new RouteConfigurationException.Problem(
                route.pattern(), option.scheme(), option.network(), reason, message);
    }

    private List<PaymentRequirements> buildRequirements(RouteConfig route) {
        List<PaymentRequirements> requirements = new ArrayList<>(route.accepts().size());
        for (PaymentOption option : route.accepts()) {
            requirements.add(resourceServer.buildPaymentRequirements(option.toResourceConfig()));
        }
        return requirements;
    }

    /**
     * Decodes the {@code PAYMENT-SIGNATURE} header.
     *
     * @return the payload, or empty when the header is absent or empty
     * @throws IllegalArgumentException if the header is not a v2 payload with a CAIP-2 {@code accepted.network}
     */
    private static Optional<PaymentPayload> extractPayment(HttpRequestAdapter request) {
        Optional<String> header = request.header(PaymentHeaders.PAYMENT_SIGNATURE).filter(value -> !value.isEmpty());
        if (header.isEmpty()) {
            return Optional.empty();
        }
        PaymentPayload payload = PaymentHeaders.decode(header.get(), PaymentPayload.class);
        if (payload.x402Version() != X402.PROTOCOL_VERSION) {
            throw new IllegalArgumentException("Unsupported x402Version " + payload.x402Version());
        }
        if (payload.accepted() == null || !Network.isValid(payload.accepted().network())) {
            throw new IllegalArgumentException("accepted.network must be a CAIP-2 identifier");
        }
        return Optional.of(payload);
    }

    private ProcessResult paymentRequired(
            List<PaymentRequirements> requirements,
            ResourceInfo resource,
            String error,
            Map<String, Object> extensions) {
        PaymentRequired message = resourceServer.createPaymentRequired(requirements, resource, error, extensions);
        String header;
        try {
            header = PaymentHeaders.encode(message);
        } catch (IllegalArgumentException e) {
            LOG.log(System.Logger.Level.WARNING, "Cannot encode the PAYMENT-REQUIRED header", e);
            return new ProcessResult.PaymentError(errorResponse(500, "Internal Server Error"));
        }
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put(CONTENT_TYPE, APPLICATION_JSON);
        headers.put(PaymentHeaders.PAYMENT_REQUIRED, header);
        headers.put(CACHE_CONTROL, NO_STORE);
        String body = error == null || error.isEmpty() ? "{}" : errorBody(error);
        return new ProcessResult.PaymentError(new HttpResponseInstructions(402, headers, body));
    }

    private static SettlementResult.Failed settlementFailure(SettleResponse receipt) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put(CONTENT_TYPE, APPLICATION_JSON);
        try {
            headers.put(PaymentHeaders.PAYMENT_RESPONSE, PaymentHeaders.encode(receipt));
        } catch (IllegalArgumentException e) {
            LOG.log(System.Logger.Level.WARNING,
                    "Cannot encode the PAYMENT-RESPONSE header; sending 402 without it", e);
        }
        headers.put(CACHE_CONTROL, NO_STORE);
        return new SettlementResult.Failed(
                receipt, new HttpResponseInstructions(402, headers, errorBody(SETTLEMENT_FAILED)));
    }

    private static SettleResponse failureReceipt(String reason, String payer, PaymentRequirements requirements) {
        return SettleResponse.failure(reason, null, payer, "", requirements.network());
    }

    /** Keeps a thrown error's transaction only while it is pending. */
    private static String sanitizedTransaction(String reason, String transaction) {
        if (X402ResourceServer.SETTLEMENT_PENDING.equals(reason) && transaction != null) {
            return transaction;
        }
        return "";
    }

    private static String networkOr(String network, PaymentRequirements requirements) {
        return network == null || network.isEmpty() ? requirements.network() : network;
    }

    private static String reasonOf(X402Exception e) {
        return e.reason() == null || e.reason().isEmpty() ? describe(e) : e.reason();
    }

    private static String describe(Exception e) {
        String message = e.getMessage();
        return message == null || message.isBlank() ? e.getClass().getSimpleName() : message;
    }

    private static HttpResponseInstructions errorResponse(int status, String error) {
        return new HttpResponseInstructions(status, Map.of(CONTENT_TYPE, APPLICATION_JSON), errorBody(error));
    }

    private static String errorBody(String error) {
        return Json.write(Map.of("error", error));
    }
}
