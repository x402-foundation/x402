package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedKind;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.StringJoiner;

/**
 * In-process facilitator that routes each payment to the {@link SchemeNetworkFacilitator} registered for its
 * scheme and network.
 *
 * <p>It implements {@link FacilitatorClient}, so a resource server can verify and settle without a network hop,
 * and it is what a facilitator HTTP service delegates {@code /verify}, {@code /settle} and {@code /supported}
 * to.
 *
 * <p>Registration takes concrete CAIP-2 networks. {@code ExactEvmFacilitatorScheme} settles only on its signer's
 * chain, so register one per network, each with a signer for that chain:
 * <pre>{@code
 * X402Facilitator facilitator = X402Facilitator.builder()
 *         .register(List.of("eip155:8453"), new ExactEvmFacilitatorScheme(baseSigner))
 *         .register(List.of("eip155:84532"), new ExactEvmFacilitatorScheme(baseSepoliaSigner))
 *         .build();
 * }</pre>
 * A registration that lists two or more networks of one namespace also serves every other network of
 * that namespace by wildcard, so list several networks only for a scheme facilitator that can serve all of them.
 * A payment is routed to the registration that lists its network explicitly; only when none does is the
 * namespace wildcard consulted, in registration order. {@link #supported()} advertises only the explicitly
 * registered networks.
 *
 * <p>Before routing, {@link #verify} and {@link #settle} check only that the payload is protocol version 2 with
 * {@code accepted} requirements, and that the requirements name a scheme and a network. Payments are routed by
 * the requirements; comparing {@code accepted} with them is left to the scheme facilitator. A failed
 * check, or the absence of a matching registration, is reported as an invalid {@link VerifyResponse} or a failed
 * {@link SettleResponse} carrying one of the reason codes declared on this class, never as an exception.
 * Exceptions thrown by the scheme facilitator propagate unchanged.
 *
 * <p>Instances are immutable and thread-safe, provided the registered scheme facilitators are.
 */
public final class X402Facilitator implements FacilitatorClient {

    /** Reason code for a payload whose {@code x402Version} is not 2. */
    public static final String INVALID_VERSION = "invalid_version";

    /** Reason code for a payload without {@code accepted} requirements. */
    public static final String INVALID_PAYLOAD = "invalid_v2_payload";

    /** Reason code for requirements without a scheme or network. */
    public static final String INVALID_REQUIREMENTS = "invalid_v2_requirements";

    /** Reason code when no registered scheme facilitator serves the scheme and network. */
    public static final String NO_FACILITATOR_FOR_NETWORK = "no_facilitator_for_network";

    private final List<Registration> registrations;

    private X402Facilitator(List<Registration> registrations) {
        this.registrations = List.copyOf(registrations);
    }

    /**
     * Returns a builder with no registered schemes.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Verifies a payment with the scheme facilitator registered for the requirements' scheme and network.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the scheme facilitator's verdict, or an invalid response with one of this class's reason codes
     *     when the payment cannot be routed
     * @throws IOException if the scheme facilitator cannot query the chain
     * @throws InterruptedException if the calling thread is interrupted
     * @throws IllegalStateException if the scheme facilitator returns {@code null}
     */
    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        Optional<Rejection> rejection = validate(payload, requirements);
        if (rejection.isPresent()) {
            return VerifyResponse.invalid(rejection.get().reason(), rejection.get().message(), null);
        }
        Optional<SchemeNetworkFacilitator> facilitator = route(requirements.scheme(), requirements.network());
        if (facilitator.isEmpty()) {
            return VerifyResponse.invalid(NO_FACILITATOR_FOR_NETWORK, noFacilitatorMessage(requirements), null);
        }
        VerifyResponse response = facilitator.get().verify(payload, requirements);
        if (response == null) {
            throw new IllegalStateException(requirements.scheme() + " facilitator returned a null VerifyResponse");
        }
        return response;
    }

    /**
     * Settles a payment with the scheme facilitator registered for the requirements' scheme and network.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the scheme facilitator's result, or a failed response with one of this class's reason codes, an
     *     empty transaction and the requirements' network when the payment cannot be routed
     * @throws IOException if the scheme facilitator cannot reach the chain
     * @throws InterruptedException if the calling thread is interrupted
     * @throws IllegalStateException if the scheme facilitator returns {@code null}
     */
    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        String network = requirements.network() == null ? "" : requirements.network();
        Optional<Rejection> rejection = validate(payload, requirements);
        if (rejection.isPresent()) {
            return SettleResponse.failure(rejection.get().reason(), rejection.get().message(), null, "", network);
        }
        Optional<SchemeNetworkFacilitator> facilitator = route(requirements.scheme(), requirements.network());
        if (facilitator.isEmpty()) {
            return SettleResponse.failure(
                    NO_FACILITATOR_FOR_NETWORK, noFacilitatorMessage(requirements), null, "", network);
        }
        SettleResponse response = facilitator.get().settle(payload, requirements);
        if (response == null) {
            throw new IllegalStateException(requirements.scheme() + " facilitator returned a null SettleResponse");
        }
        return response;
    }

    /**
     * Lists what this facilitator supports, in registration order.
     *
     * <ul>
     *   <li>{@code kinds}: one entry per registered network and scheme, with {@code x402Version} 2 and the
     *       scheme's {@link SchemeNetworkFacilitator#extra(String) extra} for that network, omitted when null
     *       or empty;</li>
     *   <li>{@code signers}: keyed by each scheme's {@link SchemeNetworkFacilitator#caipFamily() CAIP family},
     *       the distinct {@link SchemeNetworkFacilitator#signers(String) signers} across its networks;</li>
     *   <li>{@code extensions}: empty, since no extensions are implemented.</li>
     * </ul>
     *
     * <p>Extra data and signers are queried on every call, so changes made by a scheme facilitator are
     * reflected.
     *
     * @return the supported kinds and signers
     */
    @Override
    public SupportedResponse supported() {
        List<SupportedKind> kinds = new ArrayList<>();
        Map<String, Set<String>> signersByFamily = new LinkedHashMap<>();
        for (Registration registration : registrations) {
            SchemeNetworkFacilitator facilitator = registration.facilitator();
            Set<String> familySigners =
                    signersByFamily.computeIfAbsent(facilitator.caipFamily(), family -> new LinkedHashSet<>());
            for (String network : registration.networks()) {
                Map<String, Object> extra = facilitator.extra(network);
                kinds.add(new SupportedKind(X402.PROTOCOL_VERSION, registration.scheme(), network,
                        extra == null || extra.isEmpty() ? null : extra));
                List<String> signers = facilitator.signers(network);
                if (signers != null) {
                    familySigners.addAll(signers);
                }
            }
        }
        Map<String, List<String>> signers = new LinkedHashMap<>();
        signersByFamily.forEach((family, addresses) -> signers.put(family, new ArrayList<>(addresses)));
        return new SupportedResponse(kinds, List.of(), signers);
    }

    private static Optional<Rejection> validate(PaymentPayload payload, PaymentRequirements requirements) {
        if (payload.x402Version() != X402.PROTOCOL_VERSION) {
            return Optional.of(new Rejection(INVALID_VERSION, "unsupported x402Version " + payload.x402Version()
                    + "; this facilitator implements version " + X402.PROTOCOL_VERSION));
        }
        PaymentRequirements accepted = payload.accepted();
        if (accepted == null) {
            return Optional.of(new Rejection(INVALID_PAYLOAD, "payment payload has no accepted requirements"));
        }
        if (requirements.scheme() == null || requirements.network() == null) {
            return Optional.of(new Rejection(INVALID_REQUIREMENTS, "payment requirements need a scheme and network"));
        }
        return Optional.empty();
    }

    private Optional<SchemeNetworkFacilitator> route(String scheme, String network) {
        for (Registration registration : registrations) {
            if (registration.listsExactly(scheme, network)) {
                return Optional.of(registration.facilitator());
            }
        }
        for (Registration registration : registrations) {
            if (registration.coversByWildcard(scheme, network)) {
                return Optional.of(registration.facilitator());
            }
        }
        return Optional.empty();
    }

    private String noFacilitatorMessage(PaymentRequirements requirements) {
        StringJoiner registered = new StringJoiner(", ");
        registered.setEmptyValue("(none)");
        for (Registration registration : registrations) {
            for (String network : registration.networks()) {
                registered.add(registration.scheme() + "@" + network);
            }
        }
        return "no facilitator for scheme \"" + requirements.scheme() + "\" on network \""
                + requirements.network() + "\"; registered: " + registered;
    }

    /** A failed pre-routing check. */
    private record Rejection(String reason, String message) {
    }

    /**
     * One scheme facilitator serving the listed networks of a single namespace.
     *
     * @param scheme the scheme, read once at registration
     * @param facilitator the scheme facilitator
     * @param networks the explicitly registered networks, in registration order
     * @param wildcard the namespace wildcard, e.g. {@code "eip155:*"}, or {@code null} when only one network
     *     of the namespace was registered
     */
    private record Registration(
            String scheme, SchemeNetworkFacilitator facilitator, Set<String> networks, String wildcard) {

        boolean listsExactly(String requestedScheme, String network) {
            return scheme.equals(requestedScheme) && networks.contains(network);
        }

        /** Wildcards only cover concrete networks, so a requested {@code "eip155:*"} is never routed. */
        boolean coversByWildcard(String requestedScheme, String network) {
            return wildcard != null
                    && scheme.equals(requestedScheme)
                    && Network.isValid(network)
                    && Network.matches(wildcard, network);
        }
    }

    /**
     * Builder for {@link X402Facilitator}. Not thread-safe; {@link #build()} may be called more than once and each
     * facilitator keeps the registrations made before it was built.
     */
    public static final class Builder {

        private final List<Registration> registrations = new ArrayList<>();

        private Builder() {
        }

        /**
         * Registers a scheme facilitator for a set of networks.
         *
         * <p>Networks are grouped by namespace. A namespace with two or more listed networks also serves its
         * unlisted networks by wildcard, so list several only for a scheme facilitator that can serve the whole
         * namespace; see the class documentation.
         *
         * @param networks concrete CAIP-2 networks such as {@code "eip155:84532"}; wildcards are not accepted
         * @param facilitator the scheme facilitator; its {@link SchemeNetworkFacilitator#scheme()} is read once
         * @return this builder
         * @throws IllegalArgumentException if {@code networks} is empty, contains an invalid CAIP-2 identifier,
         *     or repeats a network already registered for the same scheme, or if the scheme is empty
         * @throws NullPointerException if a network or the facilitator's scheme is {@code null}
         */
        public Builder register(List<String> networks, SchemeNetworkFacilitator facilitator) {
            Objects.requireNonNull(networks, "networks");
            Objects.requireNonNull(facilitator, "facilitator");
            String scheme = Objects.requireNonNull(facilitator.scheme(), "facilitator.scheme()");
            if (scheme.isEmpty()) {
                throw new IllegalArgumentException("facilitator.scheme() must not be empty");
            }
            if (networks.isEmpty()) {
                throw new IllegalArgumentException("networks must not be empty");
            }
            Map<String, Set<String>> byNamespace = new LinkedHashMap<>();
            for (String network : networks) {
                Objects.requireNonNull(network, "network");
                if (!Network.isValid(network)) {
                    throw new IllegalArgumentException("Not a concrete CAIP-2 network: " + network);
                }
                Set<String> namespaceNetworks =
                        byNamespace.computeIfAbsent(Network.namespace(network), namespace -> new LinkedHashSet<>());
                if (isRegistered(scheme, network) || !namespaceNetworks.add(network)) {
                    throw new IllegalArgumentException(
                            "Scheme " + scheme + " is already registered for network " + network);
                }
            }
            byNamespace.forEach((namespace, namespaceNetworks) -> registrations.add(new Registration(
                    scheme,
                    facilitator,
                    Collections.unmodifiableSet(namespaceNetworks),
                    namespaceNetworks.size() > 1 ? namespace + ":*" : null)));
            return this;
        }

        /**
         * Creates the facilitator. A facilitator without registrations is valid; it supports nothing.
         *
         * @return a new facilitator with the registrations made so far
         */
        public X402Facilitator build() {
            return new X402Facilitator(registrations);
        }

        private boolean isRegistered(String scheme, String network) {
            for (Registration registration : registrations) {
                if (registration.listsExactly(scheme, network)) {
                    return true;
                }
            }
            return false;
        }
    }
}
