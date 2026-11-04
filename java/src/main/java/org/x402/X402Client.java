package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.Set;

/**
 * Pays for x402 resources: chooses one of the payment options a server offers and turns it into a signed
 * {@link PaymentPayload}.
 *
 * <p>A client is configured once with a {@link SchemeNetworkClient} per payment scheme and network, then used for
 * any number of payments. It is transport-agnostic; {@code org.x402.http.X402HttpClient} uses it to pay over HTTP.
 *
 * <pre>{@code
 * X402Client client = X402Client.builder()
 *         .register("eip155:*", new ExactEvmClientScheme(signer))   // every EVM network
 *         .spendControls(SpendControls.builder().maxAmountPerPayment("$0.10").build())
 *         .build();
 *
 * PaymentRequirements selected = client.selectPaymentRequirements(paymentRequired);
 * PaymentPayload payload = client.createPaymentPayload(paymentRequired, selected);
 * }</pre>
 *
 * <p><strong>Selection</strong> runs these steps:
 * <ol>
 *   <li>Keep the options whose {@code (network, scheme)} has a registered scheme client that
 *       {@link SchemeNetworkClient#supports supports} them. A registration under a {@code namespace:*} wildcard
 *       covers every network of that namespace; an exact registration wins over a wildcard. If nothing remains:
 *       {@link PaymentException#UNSUPPORTED_SCHEME}.</li>
 *   <li>Drop options whose {@code extra.paymentFlow} is set to anything other than {@code authorization},
 *       {@code upfront} or {@code escrow}. If nothing remains: {@link PaymentException#UNSUPPORTED_SCHEME}.</li>
 *   <li>Apply the {@link SpendControls}, on by default.</li>
 *   <li>Apply each {@link PaymentPolicy} in registration order. If one leaves nothing:
 *       {@link PaymentException#UNSUPPORTED_SCHEME}.</li>
 *   <li>If any remaining option uses the {@code authorization} flow (explicitly or by omitting
 *       {@code paymentFlow}), keep only those.</li>
 *   <li>Let the {@link PaymentRequirementsSelector} pick one; by default the first, which honours the server's
 *       preference order.</li>
 * </ol>
 *
 * <p>Instances are immutable and thread-safe, provided the registered scheme clients, policies and selector are
 * thread-safe.
 */
public final class X402Client {

    private static final String PAYMENT_FLOW = "paymentFlow";
    private static final String AUTHORIZATION_FLOW = "authorization";
    private static final Set<String> PAYMENT_FLOWS = Set.of(AUTHORIZATION_FLOW, "upfront", "escrow");

    /** Network pattern to scheme to client, both in registration order. */
    private final Map<String, Map<String, SchemeNetworkClient>> schemes;
    private final SpendControls spendControls;
    private final List<PaymentPolicy> policies;
    private final PaymentRequirementsSelector selector;

    private X402Client(Builder builder) {
        Map<String, Map<String, SchemeNetworkClient>> copy = new LinkedHashMap<>();
        builder.schemes.forEach((network, byScheme) ->
                copy.put(network, Collections.unmodifiableMap(new LinkedHashMap<>(byScheme))));
        this.schemes = Collections.unmodifiableMap(copy);
        this.spendControls = builder.spendControls;
        this.policies = List.copyOf(builder.policies);
        this.selector = builder.selector;
    }

    /**
     * Returns a new builder.
     *
     * @return a builder with default spend controls, no policies and the first-option selector
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Chooses the option to pay from a server's {@code PaymentRequired}, following the steps in the class
     * description.
     *
     * @param paymentRequired the server's payment request
     * @return one element of {@code paymentRequired.accepts()}, returned as is
     * @throws PaymentException with {@link PaymentException#INVALID_PAYMENT_REQUIRED} if the message is not a valid
     *     x402 v2 {@code PaymentRequired}, {@link PaymentException#UNSUPPORTED_SCHEME} if no option can be paid, or
     *     a {@code SPEND_CONTROLS_*} reason if spend controls reject every option
     * @throws IllegalStateException if a policy or the selector returns an option that was not offered
     */
    public PaymentRequirements selectPaymentRequirements(PaymentRequired paymentRequired) {
        List<PaymentRequirements> supported = validAccepts(paymentRequired).stream()
                .filter(requirements -> findScheme(requirements.network(), requirements.scheme())
                        .filter(scheme -> scheme.supports(requirements))
                        .isPresent())
                .toList();
        if (supported.isEmpty()) {
            throw new PaymentException(PaymentException.UNSUPPORTED_SCHEME, "no supported payment schemes available");
        }

        List<PaymentRequirements> recognized = supported.stream().filter(X402Client::hasKnownPaymentFlow).toList();
        if (recognized.isEmpty()) {
            throw new PaymentException(PaymentException.UNSUPPORTED_SCHEME,
                    "no payment requirements with a recognized paymentFlow");
        }

        List<PaymentRequirements> candidates = spendControls.filter(recognized, this::defaultAssetDecimals);
        for (PaymentPolicy policy : policies) {
            candidates = applyPolicy(policy, candidates);
        }

        List<PaymentRequirements> authorization = candidates.stream().filter(X402Client::isAuthorizationFlow).toList();
        if (!authorization.isEmpty()) {
            candidates = authorization;
        }

        PaymentRequirements selected = selector.select(candidates);
        if (selected == null || !candidates.contains(selected)) {
            throw new IllegalStateException("PaymentRequirementsSelector returned an option that was not offered");
        }
        return selected;
    }

    /**
     * Creates the payment for an option chosen from a server's {@code PaymentRequired}.
     *
     * <p>The registered scheme client signs the inner {@code payload}. The result has {@code x402Version} 2, the
     * selected option copied verbatim into {@code accepted} (servers match it field by field), and the
     * {@code resource} and {@code extensions} of {@code paymentRequired} echoed unchanged. Spend controls are
     * checked again, so an option chosen without {@link #selectPaymentRequirements} cannot exceed them.
     *
     * @param paymentRequired the server's payment request
     * @param selected the option to pay, which must be an element of {@code paymentRequired.accepts()}
     * @return the payment payload, ready to be encoded into a {@code PAYMENT-SIGNATURE} header
     * @throws IllegalArgumentException if {@code selected} is not one of the offered options
     * @throws PaymentException with {@link PaymentException#INVALID_PAYMENT_REQUIRED} if the message is not a valid
     *     x402 v2 {@code PaymentRequired}, {@link PaymentException#UNSUPPORTED_SCHEME} if no scheme client is
     *     registered for the option, a {@code SPEND_CONTROLS_*} reason if spend controls reject it, or the scheme
     *     client's reason if it cannot sign
     * @throws IllegalStateException if the scheme client returns no payload
     */
    public PaymentPayload createPaymentPayload(PaymentRequired paymentRequired, PaymentRequirements selected) {
        List<PaymentRequirements> accepts = validAccepts(paymentRequired);
        Objects.requireNonNull(selected, "selected");
        if (!accepts.contains(selected)) {
            throw new IllegalArgumentException("selected is not one of paymentRequired.accepts()");
        }
        SchemeNetworkClient scheme = findScheme(selected.network(), selected.scheme())
                .orElseThrow(() -> unsupported(selected));
        spendControls.filter(List.of(selected), this::defaultAssetDecimals);

        Map<String, Object> payload = scheme.createPaymentPayload(selected);
        if (payload == null) {
            throw new IllegalStateException("scheme client for " + selected.scheme() + " returned no payload");
        }
        return new PaymentPayload(
                X402.PROTOCOL_VERSION, payload, selected, paymentRequired.resource(), paymentRequired.extensions());
    }

    private static List<PaymentRequirements> validAccepts(PaymentRequired paymentRequired) {
        Objects.requireNonNull(paymentRequired, "paymentRequired");
        if (paymentRequired.x402Version() != X402.PROTOCOL_VERSION) {
            throw invalid("x402Version is " + paymentRequired.x402Version() + ", but this client implements version "
                    + X402.PROTOCOL_VERSION);
        }
        List<PaymentRequirements> accepts = paymentRequired.accepts();
        if (accepts == null) {
            throw invalid("accepts is missing");
        }
        for (int i = 0; i < accepts.size(); i++) {
            PaymentRequirements requirements = accepts.get(i);
            String at = "accepts[" + i + "]";
            if (requirements == null) {
                throw invalid(at + " is null");
            }
            requireField(requirements.scheme(), at, "scheme");
            requireField(requirements.network(), at, "network");
            requireField(requirements.asset(), at, "asset");
            requireField(requirements.amount(), at, "amount");
            requireField(requirements.payTo(), at, "payTo");
            if (!Network.isValid(requirements.network())) {
                throw invalid(at + ".network is not a CAIP-2 network identifier: " + requirements.network());
            }
        }
        return accepts;
    }

    private static void requireField(String value, String at, String field) {
        if (value == null) {
            throw invalid(at + "." + field + " is missing");
        }
    }

    private static PaymentException invalid(String message) {
        return new PaymentException(PaymentException.INVALID_PAYMENT_REQUIRED, message);
    }

    private PaymentException unsupported(PaymentRequirements requirements) {
        boolean networkKnown = schemes.keySet().stream()
                .anyMatch(pattern -> Network.matches(pattern, requirements.network()));
        String message = networkKnown
                ? "no client registered for scheme " + requirements.scheme() + " on network " + requirements.network()
                : "no client registered for network " + requirements.network();
        return new PaymentException(PaymentException.UNSUPPORTED_SCHEME, message);
    }

    /** Finds the client for a concrete network: an exact registration first, then wildcards in registration order. */
    private Optional<SchemeNetworkClient> findScheme(String network, String scheme) {
        Map<String, SchemeNetworkClient> exact = schemes.get(network);
        if (exact != null && exact.containsKey(scheme)) {
            return Optional.of(exact.get(scheme));
        }
        return schemes.entrySet().stream()
                .filter(entry -> Network.matches(entry.getKey(), network) && entry.getValue().containsKey(scheme))
                .map(entry -> entry.getValue().get(scheme))
                .findFirst();
    }

    private OptionalInt defaultAssetDecimals(PaymentRequirements requirements) {
        return findScheme(requirements.network(), requirements.scheme())
                .map(scheme -> scheme.defaultAssetDecimals(requirements.asset(), requirements.network()))
                .orElse(OptionalInt.empty());
    }

    private static List<PaymentRequirements> applyPolicy(PaymentPolicy policy, List<PaymentRequirements> candidates) {
        List<PaymentRequirements> kept = policy.apply(candidates);
        if (kept == null) {
            throw new IllegalStateException("PaymentPolicy returned null");
        }
        for (PaymentRequirements requirements : kept) {
            if (requirements == null || !candidates.contains(requirements)) {
                throw new IllegalStateException("PaymentPolicy returned an option that was not offered");
            }
        }
        if (kept.isEmpty()) {
            throw new PaymentException(PaymentException.UNSUPPORTED_SCHEME,
                    "all payment requirements were filtered out by policies");
        }
        return Collections.unmodifiableList(new ArrayList<>(kept));
    }

    private static Object paymentFlow(PaymentRequirements requirements) {
        Map<String, Object> extra = requirements.extra();
        return extra == null ? null : extra.get(PAYMENT_FLOW);
    }

    private static boolean hasKnownPaymentFlow(PaymentRequirements requirements) {
        Object flow = paymentFlow(requirements);
        return flow == null || flow instanceof String name && PAYMENT_FLOWS.contains(name);
    }

    private static boolean isAuthorizationFlow(PaymentRequirements requirements) {
        Object flow = paymentFlow(requirements);
        return flow == null || AUTHORIZATION_FLOW.equals(flow);
    }

    /**
     * Builds an {@link X402Client}.
     *
     * <p>Builders are not thread-safe.
     */
    public static final class Builder {

        private final Map<String, Map<String, SchemeNetworkClient>> schemes = new LinkedHashMap<>();
        private final List<PaymentPolicy> policies = new ArrayList<>();
        private SpendControls spendControls = SpendControls.defaults();
        private PaymentRequirementsSelector selector = PaymentRequirementsSelector.first();

        private Builder() {
        }

        /**
         * Registers the client for a payment scheme on a network. Registering the same scheme on the same network
         * pattern again replaces the earlier client.
         *
         * @param network a CAIP-2 network such as {@code "eip155:8453"}, or a wildcard such as {@code "eip155:*"}
         *     that covers every network of the namespace
         * @param client the scheme client; its {@link SchemeNetworkClient#scheme()} names the scheme it pays
         * @return this builder
         * @throws IllegalArgumentException if {@code network} is neither CAIP-2 nor a wildcard, or the client's
         *     scheme is {@code null} or blank
         */
        public Builder register(String network, SchemeNetworkClient client) {
            NetworkPatterns.require(network, "network");
            Objects.requireNonNull(client, "client");
            String scheme = client.scheme();
            if (scheme == null || scheme.isBlank()) {
                throw new IllegalArgumentException("client.scheme() must not be blank");
            }
            schemes.computeIfAbsent(network, key -> new LinkedHashMap<>()).put(scheme, client);
            return this;
        }

        /**
         * Replaces the spend controls. Defaults to {@link SpendControls#defaults()}.
         *
         * @param spendControls the controls, or {@link SpendControls#disabled()} to turn them off
         * @return this builder
         */
        public Builder spendControls(SpendControls spendControls) {
            this.spendControls = Objects.requireNonNull(spendControls, "spendControls");
            return this;
        }

        /**
         * Adds a policy. Policies run in the order they are added.
         *
         * @param policy the policy
         * @return this builder
         */
        public Builder policy(PaymentPolicy policy) {
            policies.add(Objects.requireNonNull(policy, "policy"));
            return this;
        }

        /**
         * Replaces the selector. Defaults to {@link PaymentRequirementsSelector#first()}.
         *
         * @param selector the selector
         * @return this builder
         */
        public Builder selector(PaymentRequirementsSelector selector) {
            this.selector = Objects.requireNonNull(selector, "selector");
            return this;
        }

        /**
         * Builds the client.
         *
         * @return the client
         * @throws IllegalStateException if no scheme client was registered
         */
        public X402Client build() {
            if (schemes.isEmpty()) {
                throw new IllegalStateException("register at least one SchemeNetworkClient");
            }
            return new X402Client(this);
        }
    }
}
