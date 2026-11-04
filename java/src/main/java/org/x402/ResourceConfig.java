package org.x402;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * One way of paying for a resource, as configured by the resource server operator.
 *
 * <p>{@link X402ResourceServer#buildPaymentRequirements(ResourceConfig)} turns a config into the
 * {@link org.x402.types.PaymentRequirements} advertised to clients: the registered
 * {@link SchemeNetworkServer} for {@code (network, scheme)} converts {@code price} into an asset amount,
 * {@code extra} is merged over the scheme's own extra data, and a {@code maxTimeoutSeconds} of {@code 0}
 * becomes {@link X402ResourceServer#DEFAULT_MAX_TIMEOUT_SECONDS}.
 *
 * <pre>{@code
 * ResourceConfig config = ResourceConfig.of(
 *         "exact", "0x209693Bc6afc0C5328bA36FaF03C514EF312287C", Price.money("$0.001"), "eip155:84532");
 * }</pre>
 *
 * <p>Instances are immutable and thread-safe.
 *
 * @param scheme the payment scheme, e.g. {@code "exact"}
 * @param payTo the recipient address, passed to clients verbatim
 * @param price the price, converted by the scheme into atomic units of an asset
 * @param network the concrete CAIP-2 network, e.g. {@code "eip155:84532"}; wildcards are not allowed
 * @param maxTimeoutSeconds the maximum time the server waits for settlement, or {@code 0} for the default
 * @param extra scheme-specific data that overrides the scheme's own {@code extra} entries, or {@code null}
 */
public record ResourceConfig(
        String scheme,
        String payTo,
        Price price,
        String network,
        int maxTimeoutSeconds,
        Map<String, Object> extra) {

    /**
     * Creates a resource config, copying {@code extra}.
     *
     * @throws IllegalArgumentException if {@code scheme} or {@code payTo} is blank, {@code network} is not a
     *     concrete CAIP-2 identifier, or {@code maxTimeoutSeconds} is negative
     */
    public ResourceConfig {
        Objects.requireNonNull(scheme, "scheme");
        Objects.requireNonNull(payTo, "payTo");
        Objects.requireNonNull(price, "price");
        Objects.requireNonNull(network, "network");
        if (scheme.isBlank()) {
            throw new IllegalArgumentException("scheme must not be blank");
        }
        if (payTo.isBlank()) {
            throw new IllegalArgumentException("payTo must not be blank");
        }
        if (!Network.isValid(network)) {
            throw new IllegalArgumentException("network must be a concrete CAIP-2 identifier: " + network);
        }
        if (maxTimeoutSeconds < 0) {
            throw new IllegalArgumentException("maxTimeoutSeconds must not be negative: " + maxTimeoutSeconds);
        }
        extra = extra == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
    }

    /**
     * Creates a resource config with the default timeout and no extra data.
     *
     * @param scheme the payment scheme, e.g. {@code "exact"}
     * @param payTo the recipient address
     * @param price the price
     * @param network the concrete CAIP-2 network
     * @return the config
     * @throws IllegalArgumentException if an argument is invalid, as described on the canonical constructor
     */
    public static ResourceConfig of(String scheme, String payTo, Price price, String network) {
        return new ResourceConfig(scheme, payTo, price, network, 0, null);
    }
}
