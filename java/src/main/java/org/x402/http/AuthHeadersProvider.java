package org.x402.http;

import java.io.IOException;
import java.util.Map;

/**
 * Supplies the headers {@link HttpFacilitatorClient} adds to each facilitator request, typically credentials.
 *
 * <p>The client calls the provider once per HTTP request, including each retry of {@code GET /supported},
 * so an implementation can hand out short-lived tokens. The returned headers are applied after the client's
 * own {@code Content-Type: application/json} and replace any header with the same name.
 *
 * <p>Example sending an API key to {@code /verify} and {@code /settle} but not to {@code /supported}:
 * <pre>{@code
 * AuthHeadersProvider auth = endpoint -> endpoint == AuthHeadersProvider.Endpoint.SUPPORTED
 *         ? Map.of()
 *         : Map.of("Authorization", "Bearer " + apiKey);
 * }</pre>
 *
 * <p>Implementations must be thread-safe: a single client may issue concurrent requests.
 */
@FunctionalInterface
public interface AuthHeadersProvider {

    /**
     * Returns the headers to add to a request to {@code endpoint}.
     *
     * <p>Header names and values must be accepted by {@link java.net.http.HttpRequest.Builder#setHeader}:
     * restricted names such as {@code Host} or {@code Content-Length} and values containing line breaks are
     * rejected.
     *
     * @param endpoint the endpoint the request is sent to
     * @return header names mapped to values, never {@code null}; an empty map adds nothing
     * @throws IOException if credentials cannot be obtained; the request is then not sent
     * @throws InterruptedException if the calling thread is interrupted while obtaining credentials
     */
    Map<String, String> headers(Endpoint endpoint) throws IOException, InterruptedException;

    /** A facilitator endpoint, with the HTTP method and path the client uses to reach it. */
    enum Endpoint {

        /** {@code POST /verify}: checks a payment without settling it. */
        VERIFY("POST", "/verify"),

        /** {@code POST /settle}: settles a payment onchain. */
        SETTLE("POST", "/settle"),

        /** {@code GET /supported}: lists the schemes, networks and signers the facilitator supports. */
        SUPPORTED("GET", "/supported");

        private final String method;
        private final String path;

        Endpoint(String method, String path) {
            this.method = method;
            this.path = path;
        }

        /**
         * Returns the HTTP method of the endpoint, {@code "GET"} or {@code "POST"}.
         *
         * @return the HTTP method
         */
        public String method() {
            return method;
        }

        /**
         * Returns the path appended to the facilitator base URL, e.g. {@code "/verify"}.
         *
         * @return the path, starting with {@code /}
         */
        public String path() {
            return path;
        }
    }
}
