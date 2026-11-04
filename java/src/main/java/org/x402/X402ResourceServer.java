package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.ResourceInfo;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Transport-independent resource server: builds the payment requirements advertised to clients, matches
 * incoming payments against them, and verifies and settles payments through facilitators.
 *
 * <p>Mirrors {@code x402ResourceServer} in {@code go/server.go}. Scheme servers are registered per concrete
 * CAIP-2 network and looked up by exact {@code (network, scheme)}.
 *
 * <pre>{@code
 * X402ResourceServer server = X402ResourceServer.builder()
 *         .facilitator(facilitatorClient)
 *         .register("eip155:84532", new ExactEvmServerScheme())
 *         .build();
 * server.initialize();
 *
 * PaymentRequirements requirements = server.buildPaymentRequirements(ResourceConfig.of(
 *         "exact", "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", Price.money("$0.001"), "eip155:84532"));
 * }</pre>
 *
 * <p>Only the {@code authorization} payment flow is supported: verify before the protected handler runs,
 * settle after it succeeds. Requirements that ask for another flow are rejected.
 *
 * <p>Instances are thread-safe. The scheme and facilitator registrations are fixed at build time.
 */
public final class X402ResourceServer {

    /** Timeout applied when a {@link ResourceConfig} leaves {@code maxTimeoutSeconds} at {@code 0}. */
    public static final int DEFAULT_MAX_TIMEOUT_SECONDS = 300;

    /** Verify failure reason when no facilitator supports the requirements' network and scheme. */
    public static final String NO_FACILITATOR_FOR_NETWORK = "no_facilitator_for_network";

    /** Settle failure reason when no facilitator supports the requirements' network and scheme. */
    public static final String NO_FACILITATOR = "no_facilitator";

    /** Verify failure reason used when the facilitator rejects a payment without giving a reason. */
    public static final String INVALID_PAYMENT = "invalid_payment";

    /** Verify failure reason when the client changed or dropped server-declared extension data. */
    public static final String EXTENSION_ECHO_MISMATCH = "extension_echo_mismatch";

    /** Settle failure reason when a transaction was broadcast but its receipt was not confirmed. */
    public static final String SETTLEMENT_PENDING = "settlement_pending";

    /** Settle failure reason when a facilitator returns no settle response at all. */
    public static final String INVALID_RESPONSE = "invalid_response";

    private static final System.Logger LOG = System.getLogger(X402ResourceServer.class.getName());

    private static final String PAYMENT_FLOW = "paymentFlow";
    private static final String AUTHORIZATION_FLOW = "authorization";
    private static final String ASSET_TRANSFER_METHOD = "assetTransferMethod";
    private static final String SDK_DEFAULT_TRANSFER_METHOD = "default";
    private static final String EIP3009_TRANSFER_METHOD = "eip3009";
    private static final String EXTENSION_INFO = "info";

    private final Map<String, Map<String, SchemeNetworkServer>> schemes;
    private final List<FacilitatorClient> facilitators;
    private volatile FacilitatorSupport support = FacilitatorSupport.NONE;

    private X402ResourceServer(Builder builder) {
        Map<String, Map<String, SchemeNetworkServer>> copy = new HashMap<>();
        builder.schemes.forEach((network, byScheme) -> copy.put(network, Map.copyOf(byScheme)));
        this.schemes = Map.copyOf(copy);
        this.facilitators = List.copyOf(builder.facilitators);
    }

    /**
     * Returns a builder for a resource server.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Fetches the supported kinds of every facilitator and routes each {@code (network, scheme)} to the
     * first facilitator that supports it.
     *
     * <p>Call this once before verifying or settling payments. Calling it again refreshes facilitator support;
     * concurrent requests keep using the previous state until the new one is complete.
     *
     * @throws IOException if a facilitator cannot be reached or returns a malformed response; the previous
     *     state is kept
     * @throws InterruptedException if the calling thread is interrupted; the previous state is kept
     */
    public void initialize() throws IOException, InterruptedException {
        List<SupportedResponse> responses = new ArrayList<>(facilitators.size());
        Map<String, Map<String, FacilitatorClient>> routing = new HashMap<>();
        for (FacilitatorClient facilitator : facilitators) {
            SupportedResponse supported = facilitator.supported();
            if (supported == null) {
                throw new IOException("Facilitator " + facilitator + " returned no supported response");
            }
            responses.add(supported);
            for (SupportedKind kind : supported.kinds()) {
                if (kind == null || kind.network() == null || kind.scheme() == null) {
                    LOG.log(System.Logger.Level.WARNING, "Ignoring incomplete supported kind {0}", kind);
                    continue;
                }
                routing.computeIfAbsent(kind.network(), network -> new HashMap<>())
                        .putIfAbsent(kind.scheme(), facilitator);
            }
        }
        support = new FacilitatorSupport(true, freeze(routing), List.copyOf(responses));
    }

    /**
     * Returns whether {@link #initialize()} has completed at least once.
     *
     * @return {@code true} once facilitator support has been fetched
     */
    public boolean isInitialized() {
        return support.initialized();
    }

    /**
     * Returns the scheme server registered for a network and scheme.
     *
     * @param network the concrete CAIP-2 network
     * @param scheme the scheme id
     * @return the scheme server, or empty when none is registered
     */
    public Optional<SchemeNetworkServer> schemeServer(String network, String scheme) {
        Objects.requireNonNull(network, "network");
        Objects.requireNonNull(scheme, "scheme");
        return Optional.ofNullable(schemes.getOrDefault(network, Map.of()).get(scheme));
    }

    /**
     * Returns whether an initialized facilitator supports a network and scheme.
     *
     * @param network the concrete CAIP-2 network
     * @param scheme the scheme id
     * @return {@code true} if a facilitator was found for the pair by {@link #initialize()}
     */
    public boolean hasFacilitatorSupport(String network, String scheme) {
        Objects.requireNonNull(network, "network");
        Objects.requireNonNull(scheme, "scheme");
        return support.facilitator(network, scheme) != null;
    }

    /**
     * Builds the payment requirements for one way of paying.
     *
     * <p>{@code config} is applied as described on {@link ResourceConfig}. When no facilitator advertised the
     * pair, the scheme server completes the requirements with an empty supported kind.
     * {@code extra.assetTransferMethod} is dropped when it is {@code eip3009} or {@code default}, since clients
     * assume {@code eip3009} when the key is absent, and an empty {@code extra} becomes {@code null}.
     *
     * @param config the resource configuration
     * @return the requirements to advertise
     * @throws IllegalArgumentException if no scheme server is registered for the network and scheme, the
     *     scheme cannot price or complete the requirements, or {@code extra.paymentFlow} asks for a flow other
     *     than {@code authorization}
     */
    public PaymentRequirements buildPaymentRequirements(ResourceConfig config) {
        Objects.requireNonNull(config, "config");
        SchemeNetworkServer scheme = schemeServer(config.network(), config.scheme())
                .orElseThrow(() -> new IllegalArgumentException(
                        "No scheme server registered for " + config.scheme() + " on " + config.network()));

        AssetAmount assetAmount = Objects.requireNonNull(
                scheme.parsePrice(config.price(), config.network()), "parsePrice returned null");
        int maxTimeoutSeconds = config.maxTimeoutSeconds() == 0
                ? DEFAULT_MAX_TIMEOUT_SECONDS
                : config.maxTimeoutSeconds();
        PaymentRequirements base = new PaymentRequirements(
                config.scheme(),
                config.network(),
                assetAmount.asset(),
                assetAmount.amount(),
                config.payTo(),
                maxTimeoutSeconds,
                mergeExtra(assetAmount.extra(), config.extra()));

        PaymentRequirements enhanced = Objects.requireNonNull(
                scheme.enhancePaymentRequirements(base, supportedKind(config.network(), config.scheme())),
                "enhancePaymentRequirements returned null");
        requireAuthorizationFlow(enhanced.extra());
        return enhanced.withExtra(wireExtra(enhanced.extra()));
    }

    /**
     * Returns the first requirement that the payment's {@code accepted} entry preserves.
     *
     * <p>{@code scheme}, {@code network}, {@code asset}, {@code amount}, {@code payTo} and
     * {@code maxTimeoutSeconds} must be equal, comparing strings case-sensitively and treating an absent string
     * as empty. Every key of the
     * requirement's {@code extra} must be present in {@code accepted.extra} with an equal value; nested objects
     * may carry additional keys, and a key whose server value is {@code null} may be absent.
     *
     * @param available the requirements advertised for the resource
     * @param payload the client's payment
     * @return the matching requirement, or empty when none matches
     */
    public Optional<PaymentRequirements> findMatchingRequirements(
            List<PaymentRequirements> available, PaymentPayload payload) {
        Objects.requireNonNull(available, "available");
        Objects.requireNonNull(payload, "payload");
        PaymentRequirements accepted = payload.accepted();
        if (accepted == null) {
            return Optional.empty();
        }
        for (PaymentRequirements required : available) {
            if (required != null && matches(required, accepted)) {
                return Optional.of(required);
            }
        }
        return Optional.empty();
    }

    /**
     * Verifies a payment that declares no extensions.
     *
     * @param payload the client's payment
     * @param requirements the matched requirements
     * @return the facilitator's response, always with {@code isValid=true}
     * @throws VerifyException if the payment is invalid, as described on
     *     {@link #verify(PaymentPayload, PaymentRequirements, Map)}
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     * @see #verify(PaymentPayload, PaymentRequirements, Map)
     */
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        return verify(payload, requirements, null);
    }

    /**
     * Verifies a payment with the facilitator routed to its network and scheme.
     *
     * <p>Before contacting the facilitator, the client's {@code extensions} are checked against
     * {@code declaredExtensions}: for every extension the server declared, the client may omit it or echo it,
     * but an echo must preserve every server-declared value (comparing the {@code info} object when present).
     * Additional fields are allowed. Extensions the server did not declare are ignored.
     *
     * @param payload the client's payment
     * @param requirements the matched requirements
     * @param declaredExtensions the extensions the server advertised, or {@code null} for none
     * @return the facilitator's response, always with {@code isValid=true}
     * @throws VerifyException with reason {@value #EXTENSION_ECHO_MISMATCH} if an echoed extension does not
     *     preserve the declared one; {@value #INVALID_PAYMENT} if no scheme is registered for the requirements,
     *     they ask for an unsupported payment flow, or the facilitator rejects the payment without a reason;
     *     {@value #NO_FACILITATOR_FOR_NETWORK} if no facilitator supports the network and scheme; otherwise the
     *     facilitator's {@code invalidReason}
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     */
    public VerifyResponse verify(
            PaymentPayload payload, PaymentRequirements requirements, Map<String, Object> declaredExtensions)
            throws IOException, InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        validateExtensions(declaredExtensions, payload);

        if (schemeServer(requirements.network(), requirements.scheme()).isEmpty()) {
            throw new VerifyException(INVALID_PAYMENT, null, "No scheme implementation registered for "
                    + requirements.scheme() + " on network " + requirements.network());
        }
        String flow = paymentFlow(requirements.extra());
        if (!AUTHORIZATION_FLOW.equals(flow)) {
            throw new VerifyException(INVALID_PAYMENT, null, "Unsupported payment flow " + flow);
        }
        FacilitatorClient facilitator = support.facilitator(requirements.network(), requirements.scheme());
        if (facilitator == null) {
            throw new VerifyException(NO_FACILITATOR_FOR_NETWORK, null, "No facilitator for scheme="
                    + requirements.scheme() + " network=" + requirements.network());
        }

        VerifyResponse response = facilitator.verify(payload, requirements);
        if (response == null || !response.isValid()) {
            String reason = response == null || isEmpty(response.invalidReason())
                    ? INVALID_PAYMENT
                    : response.invalidReason();
            throw new VerifyException(
                    reason,
                    response == null ? null : response.payer(),
                    response == null ? "Facilitator returned no verify response" : response.invalidMessage());
        }
        return response;
    }

    /**
     * Settles a payment with the facilitator routed to its network and scheme.
     *
     * <p>When the first attempt fails with {@value #SETTLEMENT_PENDING} and carries a transaction hash, either
     * as a returned response or as a thrown {@link SettleException}, the facilitator is asked once more with
     * the same inputs so it can reconcile the broadcast transaction.
     *
     * <p>A response with {@code success=false} is returned, not thrown, so that its receipt (transaction,
     * amount, extra) can reach the client. Callers must check {@link SettleResponse#success()} and
     * must not deliver the resource unless it is {@code true}.
     *
     * @param payload the client's payment
     * @param requirements the matched requirements
     * @return the facilitator's settle response; {@code success=false} means the payment did not settle
     * @throws SettleException with reason {@value #NO_FACILITATOR} if no facilitator supports the network and
     *     scheme, {@value #INVALID_RESPONSE} if the facilitator returned nothing, or the facilitator's own reason
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     */
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        FacilitatorClient facilitator = support.facilitator(requirements.network(), requirements.scheme());
        if (facilitator == null) {
            throw new SettleException(NO_FACILITATOR, null, requirements.network(), "", "No facilitator for scheme="
                    + requirements.scheme() + " network=" + requirements.network());
        }
        SettleResponse response = settleWithPendingRetry(facilitator, payload, requirements);
        if (response == null) {
            throw new SettleException(INVALID_RESPONSE, null, requirements.network(), "",
                    "Facilitator returned no settle response");
        }
        return response;
    }

    /**
     * Creates the {@code PaymentRequired} message sent with an HTTP 402 response.
     *
     * @param requirements the accepted ways of paying, in preference order
     * @param resource the protected resource, or {@code null}
     * @param error a short reason the payment is required, or {@code null}
     * @param extensions the declared extensions, or {@code null}
     * @return the message, with {@code x402Version} {@value X402#PROTOCOL_VERSION}
     */
    public PaymentRequired createPaymentRequired(
            List<PaymentRequirements> requirements,
            ResourceInfo resource,
            String error,
            Map<String, Object> extensions) {
        Objects.requireNonNull(requirements, "requirements");
        return new PaymentRequired(X402.PROTOCOL_VERSION, error, resource, requirements, extensions);
    }

    private SupportedKind supportedKind(String network, String scheme) {
        for (SupportedResponse response : support.responses()) {
            for (SupportedKind kind : response.kinds()) {
                if (kind != null
                        && kind.x402Version() == X402.PROTOCOL_VERSION
                        && scheme.equals(kind.scheme())
                        && network.equals(kind.network())) {
                    return kind;
                }
            }
        }
        return new SupportedKind(X402.PROTOCOL_VERSION, scheme, network, Map.of());
    }

    private static SettleResponse settleWithPendingRetry(
            FacilitatorClient facilitator, PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        try {
            SettleResponse first = facilitator.settle(payload, requirements);
            if (first == null || first.success() || !isRetryablePending(first.errorReason(), first.transaction())) {
                return first;
            }
        } catch (SettleException e) {
            if (!isRetryablePending(e.reason(), e.transaction())) {
                throw e;
            }
        }
        LOG.log(System.Logger.Level.DEBUG, "Settlement pending on {0}, retrying once", requirements.network());
        return facilitator.settle(payload, requirements);
    }

    private static boolean isRetryablePending(String reason, String transaction) {
        return SETTLEMENT_PENDING.equals(reason) && !isEmpty(transaction);
    }

    private static boolean matches(PaymentRequirements required, PaymentRequirements accepted) {
        if (!sameString(required.scheme(), accepted.scheme())
                || !sameString(required.network(), accepted.network())
                || !sameString(required.asset(), accepted.asset())
                || !sameString(required.amount(), accepted.amount())
                || !sameString(required.payTo(), accepted.payTo())
                || required.maxTimeoutSeconds() != accepted.maxTimeoutSeconds()) {
            return false;
        }
        if (required.extra() == null) {
            return true;
        }
        JsonNode acceptedExtra = Json.toTree(accepted.extra() == null ? Map.of() : accepted.extra());
        return JsonValues.containsSubset(Json.toTree(required.extra()), acceptedExtra);
    }

    /** Compares wire strings, treating an absent string and an empty one alike. */
    private static boolean sameString(String a, String b) {
        return Objects.equals(a == null ? "" : a, b == null ? "" : b);
    }

    private static void validateExtensions(Map<String, Object> declared, PaymentPayload payload) {
        if (payload.x402Version() != X402.PROTOCOL_VERSION
                || payload.extensions() == null
                || payload.extensions().isEmpty()
                || declared == null) {
            return;
        }
        for (Map.Entry<String, Object> echoed : payload.extensions().entrySet()) {
            if (!declared.containsKey(echoed.getKey())) {
                continue;
            }
            JsonNode advertisedInfo = extensionInfo(declared.get(echoed.getKey()));
            JsonNode echoedInfo = extensionInfo(echoed.getValue());
            if (!JsonValues.containsSubset(advertisedInfo, echoedInfo)) {
                throw new VerifyException(EXTENSION_ECHO_MISMATCH, null,
                        "extension \"" + echoed.getKey() + "\" echo does not preserve server-advertised info");
            }
        }
    }

    private static JsonNode extensionInfo(Object extension) {
        JsonNode node = Json.toTree(extension);
        if (node.isObject() && node.has(EXTENSION_INFO)) {
            return node.get(EXTENSION_INFO);
        }
        return node;
    }

    private static Map<String, Object> mergeExtra(Map<String, Object> parsed, Map<String, Object> configured) {
        if (isEmpty(parsed) && isEmpty(configured)) {
            return null;
        }
        Map<String, Object> merged = new LinkedHashMap<>();
        if (parsed != null) {
            merged.putAll(parsed);
        }
        if (configured != null) {
            merged.putAll(configured);
        }
        return merged;
    }

    private static void requireAuthorizationFlow(Map<String, Object> extra) {
        String flow = paymentFlow(extra);
        if (!AUTHORIZATION_FLOW.equals(flow)) {
            throw new IllegalArgumentException(
                    "Unsupported payment flow " + flow + "; only " + AUTHORIZATION_FLOW + " is supported");
        }
    }

    /** Returns the requested payment flow; an absent or {@code null} value means {@code authorization}. */
    private static String paymentFlow(Map<String, Object> extra) {
        Object flow = extra == null ? null : extra.get(PAYMENT_FLOW);
        return flow == null ? AUTHORIZATION_FLOW : String.valueOf(flow);
    }

    private static Map<String, Object> wireExtra(Map<String, Object> extra) {
        if (extra == null) {
            return null;
        }
        Map<String, Object> wire = new LinkedHashMap<>(extra);
        Object method = wire.get(ASSET_TRANSFER_METHOD);
        if (SDK_DEFAULT_TRANSFER_METHOD.equals(method) || EIP3009_TRANSFER_METHOD.equals(method)) {
            wire.remove(ASSET_TRANSFER_METHOD);
        }
        return wire.isEmpty() ? null : wire;
    }

    private static boolean isEmpty(String value) {
        return value == null || value.isEmpty();
    }

    private static boolean isEmpty(Map<?, ?> map) {
        return map == null || map.isEmpty();
    }

    private static Map<String, Map<String, FacilitatorClient>> freeze(
            Map<String, Map<String, FacilitatorClient>> routing) {
        Map<String, Map<String, FacilitatorClient>> frozen = new HashMap<>();
        routing.forEach((network, byScheme) -> frozen.put(network, Map.copyOf(byScheme)));
        return Collections.unmodifiableMap(frozen);
    }

    /** Facilitator support published by {@link #initialize()}; replaced as a whole, never mutated. */
    private record FacilitatorSupport(
            boolean initialized,
            Map<String, Map<String, FacilitatorClient>> routing,
            List<SupportedResponse> responses) {

        static final FacilitatorSupport NONE = new FacilitatorSupport(false, Map.of(), List.of());

        FacilitatorClient facilitator(String network, String scheme) {
            if (network == null || scheme == null) {
                return null;
            }
            return routing.getOrDefault(network, Map.of()).get(scheme);
        }
    }

    /**
     * Builder for {@link X402ResourceServer}.
     *
     * <p>Not thread-safe; build the server on one thread and share the result.
     */
    public static final class Builder {

        private final Map<String, Map<String, SchemeNetworkServer>> schemes = new HashMap<>();
        private final List<FacilitatorClient> facilitators = new ArrayList<>();

        private Builder() {
        }

        /**
         * Registers a scheme server for a concrete network. A later registration for the same network and
         * scheme replaces the earlier one.
         *
         * @param network the concrete CAIP-2 network, e.g. {@code "eip155:84532"}
         * @param server the scheme server
         * @return this builder
         * @throws IllegalArgumentException if {@code network} is not a concrete CAIP-2 identifier; wildcard
         *     patterns such as {@code "eip155:*"} are rejected because server lookups are exact
         */
        public Builder register(String network, SchemeNetworkServer server) {
            Objects.requireNonNull(network, "network");
            Objects.requireNonNull(server, "server");
            if (!Network.isValid(network)) {
                throw new IllegalArgumentException(
                        "Scheme servers must be registered per concrete CAIP-2 network, got: " + network);
            }
            String scheme = Objects.requireNonNull(server.scheme(), "server.scheme()");
            schemes.computeIfAbsent(network, key -> new HashMap<>()).put(scheme, server);
            return this;
        }

        /**
         * Adds a facilitator. Facilitators added earlier take precedence when several support the same network
         * and scheme.
         *
         * @param facilitator the facilitator client
         * @return this builder
         */
        public Builder facilitator(FacilitatorClient facilitator) {
            facilitators.add(Objects.requireNonNull(facilitator, "facilitator"));
            return this;
        }

        /**
         * Adds facilitators in list order.
         *
         * @param facilitators the facilitator clients
         * @return this builder
         */
        public Builder facilitators(List<? extends FacilitatorClient> facilitators) {
            Objects.requireNonNull(facilitators, "facilitators").forEach(this::facilitator);
            return this;
        }

        /**
         * Builds the resource server. Call {@link X402ResourceServer#initialize()} on the result before use.
         *
         * @return the resource server
         */
        public X402ResourceServer build() {
            return new X402ResourceServer(this);
        }
    }
}
