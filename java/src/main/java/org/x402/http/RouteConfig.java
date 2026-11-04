package org.x402.http;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Payment configuration of one protected route, registered on an {@link HttpResourceServer} under a route
 * pattern such as {@code "GET /weather"}.
 *
 * <p>A request matching the route must pay with one of the {@link #accepts()} options. The options appear in
 * the 402 response in list order, which clients treat as the server's preference. {@code resource},
 * {@code description} and {@code mimeType} describe the resource in the 402 response; when {@code resource}
 * is {@code null} the request URL is used. {@code extensions} are declared to clients as is; a client may omit
 * them or echo them, but must not change declared values.
 *
 * <pre>{@code
 * RouteConfig weather = RouteConfig.builder()
 *         .accept(PaymentOption.builder()
 *                 .scheme("exact")
 *                 .network("eip155:84532")
 *                 .payTo("0x209693Bc6afc0C5328bA36FaF03C514EF312287C")
 *                 .price(Price.money("$0.001"))
 *                 .build())
 *         .description("Current weather")
 *         .mimeType("application/json")
 *         .build();
 *
 * HttpResourceServer http = new HttpResourceServer(resourceServer, Map.of("GET /weather", weather));
 * }</pre>
 *
 * <p>A route with no options and no extensions does not require payment.
 *
 * <p>Instances are immutable and thread-safe.
 *
 * @param accepts the accepted payment options, in preference order
 * @param resource the resource URL advertised to clients, or {@code null} to use the request URL
 * @param description a human-readable description, or {@code null}
 * @param mimeType the MIME type of the protected response, or {@code null}
 * @param extensions extension declarations keyed by extension id, or {@code null}
 */
public record RouteConfig(
        List<PaymentOption> accepts,
        String resource,
        String description,
        String mimeType,
        Map<String, Object> extensions) {

    /**
     * Creates a route configuration, copying the collections.
     */
    public RouteConfig {
        accepts = List.copyOf(Objects.requireNonNull(accepts, "accepts"));
        extensions = extensions == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(extensions));
    }

    /**
     * Returns a builder for a route configuration.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builder for {@link RouteConfig}.
     *
     * <p>Not thread-safe.
     */
    public static final class Builder {

        private final List<PaymentOption> accepts = new ArrayList<>();
        private String resource;
        private String description;
        private String mimeType;
        private Map<String, Object> extensions;

        private Builder() {
        }

        /**
         * Appends an accepted payment option.
         *
         * @param option the option
         * @return this builder
         */
        public Builder accept(PaymentOption option) {
            accepts.add(Objects.requireNonNull(option, "option"));
            return this;
        }

        /**
         * Appends accepted payment options in list order.
         *
         * @param options the options
         * @return this builder
         */
        public Builder accepts(List<PaymentOption> options) {
            Objects.requireNonNull(options, "options").forEach(this::accept);
            return this;
        }

        /**
         * Sets the resource URL advertised to clients.
         *
         * @param resource an absolute URL, or {@code null} to use the request URL
         * @return this builder
         */
        public Builder resource(String resource) {
            this.resource = resource;
            return this;
        }

        /**
         * Sets the human-readable description.
         *
         * @param description the description, or {@code null}
         * @return this builder
         */
        public Builder description(String description) {
            this.description = description;
            return this;
        }

        /**
         * Sets the MIME type of the protected response.
         *
         * @param mimeType e.g. {@code "application/json"}, or {@code null}
         * @return this builder
         */
        public Builder mimeType(String mimeType) {
            this.mimeType = mimeType;
            return this;
        }

        /**
         * Sets the extension declarations, replacing any previously set map.
         *
         * @param extensions declarations keyed by extension id, each typically {@code {"info": ..., "schema": ...}},
         *     or {@code null}
         * @return this builder
         */
        public Builder extensions(Map<String, Object> extensions) {
            this.extensions = extensions;
            return this;
        }

        /**
         * Builds the route configuration.
         *
         * @return the route configuration
         */
        public RouteConfig build() {
            return new RouteConfig(accepts, resource, description, mimeType, extensions);
        }
    }
}
