package org.x402.http;

import org.x402.Price;
import org.x402.ResourceConfig;

import java.util.Map;

/**
 * One way a client can pay for a route, listed in {@link RouteConfig#accepts()}.
 *
 * <p>Each option becomes one entry of the 402 response's {@code accepts} array. Values are static; the price
 * is converted into atomic units of an asset by the scheme server registered for {@code (network, scheme)}.
 *
 * <pre>{@code
 * PaymentOption option = PaymentOption.builder()
 *         .scheme("exact")
 *         .network("eip155:84532")
 *         .payTo("0x209693Bc6afc0C5328bA36FaF03C514EF312287C")
 *         .price(Price.money("$0.001"))
 *         .build();
 * }</pre>
 *
 * <p>Instances are immutable and thread-safe.
 *
 * @param scheme the payment scheme, e.g. {@code "exact"}
 * @param payTo the recipient address
 * @param price the price
 * @param network the concrete CAIP-2 network, e.g. {@code "eip155:84532"}
 * @param maxTimeoutSeconds the maximum settlement time, or {@code 0} for
 *     {@link org.x402.X402ResourceServer#DEFAULT_MAX_TIMEOUT_SECONDS}
 * @param extra scheme-specific data merged over the scheme's own {@code extra}, or {@code null}
 */
public record PaymentOption(
        String scheme,
        String payTo,
        Price price,
        String network,
        int maxTimeoutSeconds,
        Map<String, Object> extra) {

    /**
     * Creates a payment option, copying {@code extra}.
     *
     * @throws IllegalArgumentException under the same conditions as {@link ResourceConfig}'s constructor
     */
    public PaymentOption {
        // ResourceConfig enforces the same invariants and makes the defensive copy of extra.
        extra = new ResourceConfig(scheme, payTo, price, network, maxTimeoutSeconds, extra).extra();
    }

    /**
     * Returns a builder for a payment option.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Converts this option into the transport-independent configuration used by
     * {@link org.x402.X402ResourceServer#buildPaymentRequirements(ResourceConfig)}.
     *
     * @return the resource configuration
     */
    public ResourceConfig toResourceConfig() {
        return new ResourceConfig(scheme, payTo, price, network, maxTimeoutSeconds, extra);
    }

    /**
     * Builder for {@link PaymentOption}. {@code scheme}, {@code network}, {@code payTo} and {@code price} are
     * required.
     *
     * <p>Not thread-safe.
     */
    public static final class Builder {

        private String scheme;
        private String payTo;
        private Price price;
        private String network;
        private int maxTimeoutSeconds;
        private Map<String, Object> extra;

        private Builder() {
        }

        /**
         * Sets the payment scheme.
         *
         * @param scheme the scheme id, e.g. {@code "exact"}
         * @return this builder
         */
        public Builder scheme(String scheme) {
            this.scheme = scheme;
            return this;
        }

        /**
         * Sets the recipient address.
         *
         * @param payTo the address that receives the payment
         * @return this builder
         */
        public Builder payTo(String payTo) {
            this.payTo = payTo;
            return this;
        }

        /**
         * Sets the price.
         *
         * @param price e.g. {@code Price.money("$0.001")} or {@code AssetAmount.of("1000", "0x036C...")}
         * @return this builder
         */
        public Builder price(Price price) {
            this.price = price;
            return this;
        }

        /**
         * Sets the network.
         *
         * @param network the concrete CAIP-2 network, e.g. {@code "eip155:84532"}
         * @return this builder
         */
        public Builder network(String network) {
            this.network = network;
            return this;
        }

        /**
         * Sets the maximum time the server waits for settlement.
         *
         * @param maxTimeoutSeconds a positive number of seconds, or {@code 0} for the default of 300
         * @return this builder
         */
        public Builder maxTimeoutSeconds(int maxTimeoutSeconds) {
            this.maxTimeoutSeconds = maxTimeoutSeconds;
            return this;
        }

        /**
         * Sets scheme-specific data, replacing any previously set map.
         *
         * @param extra data merged over the scheme's own {@code extra}, or {@code null}
         * @return this builder
         */
        public Builder extra(Map<String, Object> extra) {
            this.extra = extra;
            return this;
        }

        /**
         * Builds the payment option.
         *
         * @return the payment option
         * @throws NullPointerException if a required value is missing
         * @throws IllegalArgumentException if a value is invalid
         */
        public PaymentOption build() {
            return new PaymentOption(scheme, payTo, price, network, maxTimeoutSeconds, extra);
        }
    }
}
