package org.x402.http;

import org.x402.FacilitatorClient;
import org.x402.SettleException;
import org.x402.VerifyException;
import org.x402.http.AuthHeadersProvider.Endpoint;
import org.x402.types.FacilitatorRequest;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;
import org.x402.util.BoundedBodySubscriber;
import org.x402.util.Json;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublisher;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.EnumMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * {@link FacilitatorClient} that calls a remote facilitator over HTTP.
 *
 * <p>Response bodies larger than 1 MiB are rejected with {@link IOException}.
 *
 * <p>Example:
 * <pre>{@code
 * FacilitatorClient facilitator = HttpFacilitatorClient.builder()
 *         .url("https://x402.org/facilitator")
 *         .authHeadersProvider(endpoint -> Map.of("Authorization", "Bearer " + apiKey))
 *         .build();
 * }</pre>
 *
 * <p>Instances are immutable and thread-safe, provided the injected {@link AuthHeadersProvider} is.
 */
public final class HttpFacilitatorClient implements FacilitatorClient {

    /** Base URL of the public x402.org facilitator, used when no URL is configured. */
    public static final String DEFAULT_URL = "https://x402.org/facilitator";

    /** Default request timeout: 90 seconds. */
    public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(90);

    /** Attempts of {@code GET /supported} made while the facilitator answers HTTP 429. */
    static final int SUPPORTED_MAX_ATTEMPTS = 3;

    /** Largest response body buffered. */
    static final int MAX_RESPONSE_BYTES = 1 << 20;

    private static final Duration SUPPORTED_RETRY_BASE_DELAY = Duration.ofSeconds(1);
    private static final int TOO_MANY_REQUESTS = 429;
    private static final String CONTENT_TYPE = "Content-Type";
    private static final String APPLICATION_JSON = "application/json";
    private static final AuthHeadersProvider NO_AUTH_HEADERS = endpoint -> Map.of();
    private static final System.Logger LOGGER = System.getLogger(HttpFacilitatorClient.class.getName());

    private final String url;
    private final Map<Endpoint, URI> endpointUris;
    private final HttpClient httpClient;
    private final Duration timeout;
    private final AuthHeadersProvider authHeadersProvider;
    private final Sleeper sleeper;

    private HttpFacilitatorClient(Builder builder) {
        this.url = builder.url;
        this.endpointUris = new EnumMap<>(Endpoint.class);
        for (Endpoint endpoint : Endpoint.values()) {
            endpointUris.put(endpoint, URI.create(url + endpoint.path()));
        }
        this.httpClient = builder.httpClient != null
                ? builder.httpClient
                : HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();
        this.timeout = builder.timeout;
        this.authHeadersProvider = builder.authHeadersProvider;
        this.sleeper = builder.sleeper;
    }

    /**
     * Returns a builder preconfigured with {@link #DEFAULT_URL}, {@link #DEFAULT_TIMEOUT}, no auth headers and
     * a new {@link HttpClient}.
     *
     * @return a new builder
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Returns the facilitator base URL, without a trailing slash.
     *
     * @return the base URL, e.g. {@code "https://x402.org/facilitator"}
     */
    public String url() {
        return url;
    }

    /**
     * Verifies a payment with {@code POST /verify}.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the facilitator's verdict; an invalid payment reported with a 2xx status has {@code isValid=false}
     * @throws VerifyException if the facilitator answers non-2xx with an {@code invalidReason}
     * @throws IOException if the request fails, times out, or the response is not a valid verify response
     * @throws InterruptedException if the calling thread is interrupted
     */
    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        RawResponse response = send(Endpoint.VERIFY, requestBody(payload, requirements));
        if (!response.isSuccess()) {
            Optional<VerifyException> rejection = FacilitatorResponses.verifyRejection(response.body());
            if (rejection.isPresent()) {
                throw rejection.get();
            }
            throw FacilitatorResponses.unexpectedStatus(Endpoint.VERIFY, response.status(), response.body());
        }
        return FacilitatorResponses.parseVerify(response.body());
    }

    /**
     * Settles a payment with {@code POST /settle}.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the settlement result; a failure reported with a 2xx status has {@code success=false}
     * @throws SettleException if the facilitator answers non-2xx with an {@code errorReason}
     * @throws IOException if the request fails, times out, or the response is not a valid settle response
     * @throws InterruptedException if the calling thread is interrupted
     */
    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException {
        RawResponse response = send(Endpoint.SETTLE, requestBody(payload, requirements));
        if (!response.isSuccess()) {
            Optional<SettleException> rejection =
                    FacilitatorResponses.settleRejection(response.status(), response.body());
            if (rejection.isPresent()) {
                throw rejection.get();
            }
            throw FacilitatorResponses.unexpectedStatus(Endpoint.SETTLE, response.status(), response.body());
        }
        return FacilitatorResponses.parseSettle(response.body());
    }

    /**
     * Fetches the facilitator's capabilities with {@code GET /supported}.
     *
     * <p>While the facilitator answers HTTP 429 the request is repeated, up to 3 attempts in total, waiting
     * 1 second before the second attempt and 2 seconds before the third.
     *
     * @return the supported kinds, extensions and signers; absent collections are empty
     * @throws IOException if the request fails, times out, the facilitator answers non-2xx (including a third
     *     429), or the response is not a valid supported response
     * @throws InterruptedException if the calling thread is interrupted, including while waiting to retry
     */
    @Override
    public SupportedResponse supported() throws IOException, InterruptedException {
        for (int attempt = 1; ; attempt++) {
            RawResponse response = send(Endpoint.SUPPORTED, BodyPublishers.noBody());
            if (response.isSuccess()) {
                return FacilitatorResponses.parseSupported(response.body());
            }
            if (response.status() != TOO_MANY_REQUESTS || attempt == SUPPORTED_MAX_ATTEMPTS) {
                throw FacilitatorResponses.unexpectedStatus(Endpoint.SUPPORTED, response.status(), response.body());
            }
            Duration delay = SUPPORTED_RETRY_BASE_DELAY.multipliedBy(1L << (attempt - 1));
            LOGGER.log(System.Logger.Level.DEBUG,
                    "Facilitator {0} rate limited GET /supported on attempt {1} of {2}; retrying in {3} ms",
                    url, attempt, SUPPORTED_MAX_ATTEMPTS, delay.toMillis());
            sleeper.sleep(delay);
        }
    }

    /**
     * Returns a description naming the base URL; credentials are never included.
     *
     * @return the description
     */
    @Override
    public String toString() {
        return "HttpFacilitatorClient[url=" + url + "]";
    }

    private static BodyPublisher requestBody(PaymentPayload payload, PaymentRequirements requirements) {
        Objects.requireNonNull(payload, "payload");
        Objects.requireNonNull(requirements, "requirements");
        String json = Json.write(new FacilitatorRequest(payload.x402Version(), payload, requirements));
        return BodyPublishers.ofString(json);
    }

    /**
     * Sends a request and reads at most {@link #MAX_RESPONSE_BYTES} of its body within the timeout.
     * On JDK 17 {@link HttpRequest#timeout} stops counting once the headers arrive, so a facilitator that stalls
     * mid-body could otherwise block the caller forever.
     */
    private RawResponse send(Endpoint endpoint, BodyPublisher body) throws IOException, InterruptedException {
        HttpRequest.Builder request = HttpRequest.newBuilder(endpointUris.get(endpoint))
                .timeout(timeout)
                .header(CONTENT_TYPE, APPLICATION_JSON)
                .method(endpoint.method(), body);
        Map<String, String> headers = authHeadersProvider.headers(endpoint);
        if (headers == null) {
            throw new IllegalStateException("AuthHeadersProvider returned null headers for " + endpoint);
        }
        headers.forEach(request::setHeader);
        CompletableFuture<HttpResponse<byte[]>> pending =
                httpClient.sendAsync(request.build(), info -> new BoundedBodySubscriber(MAX_RESPONSE_BYTES));
        HttpResponse<byte[]> response;
        try {
            response = pending.get(timeout.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            pending.cancel(true);
            HttpTimeoutException timedOut = new HttpTimeoutException(
                    "Facilitator " + endpoint.path() + ": no complete response within " + timeout);
            timedOut.initCause(e);
            throw timedOut;
        } catch (InterruptedException e) {
            pending.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            throw sendFailure(endpoint, e.getCause());
        }
        return new RawResponse(response.statusCode(), response.body());
    }

    private static IOException sendFailure(Endpoint endpoint, Throwable cause) {
        if (cause instanceof BoundedBodySubscriber.TooLargeException) {
            return new IOException("Facilitator " + endpoint.path() + " response body exceeds "
                    + MAX_RESPONSE_BYTES + " bytes", cause);
        }
        if (cause instanceof IOException io) {
            return io;
        }
        return new IOException("Facilitator " + endpoint.path() + " request failed", cause);
    }

    /**
     * Validates and normalizes a facilitator base URL.
     *
     * <p>Messages never repeat the URL, because a rejected URL may embed an API key.
     *
     * @throws IllegalArgumentException if the URL is not an absolute http(s) URL with a host, or carries user
     *     info, a query or a fragment
     */
    static String normalizeUrl(String url) {
        Objects.requireNonNull(url, "url");
        int end = url.length();
        while (end > 0 && url.charAt(end - 1) == '/') {
            end--;
        }
        String trimmed = url.substring(0, end);
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException e) {
            // The cause is dropped on purpose: its message quotes the whole URL.
            throw new IllegalArgumentException(
                    "Invalid facilitator URL: " + e.getReason() + " at index " + e.getIndex());
        }
        String scheme = uri.getScheme();
        boolean http = "http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme);
        if (!http || uri.getHost() == null) {
            throw new IllegalArgumentException("Facilitator URL must be an absolute http or https URL with a host");
        }
        if (uri.getRawUserInfo() != null) {
            throw new IllegalArgumentException(
                    "Facilitator URL must not contain credentials; use an AuthHeadersProvider instead");
        }
        if (uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException(
                    "Facilitator URL must not have a query or fragment; use an AuthHeadersProvider for credentials");
        }
        return trimmed;
    }

    /** Waits between retries. Tests substitute it to assert the backoff schedule without sleeping. */
    @FunctionalInterface
    interface Sleeper {

        /** Sleeps on the calling thread. */
        Sleeper SYSTEM = duration -> TimeUnit.MILLISECONDS.sleep(duration.toMillis());

        void sleep(Duration duration) throws InterruptedException;
    }

    /** Status and fully buffered body of a facilitator response. */
    private record RawResponse(int status, byte[] body) {

        boolean isSuccess() {
            return status / 100 == 2;
        }
    }

    /**
     * Builder for {@link HttpFacilitatorClient}. Not thread-safe; {@link #build()} may be called more than once
     * and each client keeps the settings in effect when it was built.
     */
    public static final class Builder {

        private String url = DEFAULT_URL;
        private HttpClient httpClient;
        private Duration timeout = DEFAULT_TIMEOUT;
        private AuthHeadersProvider authHeadersProvider = NO_AUTH_HEADERS;
        private Sleeper sleeper = Sleeper.SYSTEM;

        private Builder() {
        }

        /**
         * Sets the facilitator base URL. Trailing slashes are removed and the endpoint paths are appended, so
         * {@code "https://f.example/x402/"} sends verify requests to {@code https://f.example/x402/verify}.
         *
         * @param url an absolute {@code http} or {@code https} URL with a host and without user info, query or
         *     fragment; defaults to {@link #DEFAULT_URL}
         * @return this builder
         * @throws IllegalArgumentException if {@code url} does not meet those rules
         */
        public Builder url(String url) {
            this.url = normalizeUrl(url);
            return this;
        }

        /**
         * Sets the HTTP client that sends every request. Its executor, proxy, TLS settings and redirect policy
         * apply. Defaults to an HTTP/1.1 client that does not follow redirects: the JDK's HTTP/2 client sends an
         * {@code h2c} upgrade on {@code http://} URLs, and HTTP/1.1-only servers such as uvicorn then drop the
         * request body.
         *
         * @param httpClient the client to use
         * @return this builder
         */
        public Builder httpClient(HttpClient httpClient) {
            this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
            return this;
        }

        /**
         * Sets how long each request may take, from sending it to reading the last byte of the response body,
         * before failing with {@link HttpTimeoutException}. Each {@code GET /supported} attempt has its own timeout.
         *
         * @param timeout a positive duration; defaults to {@link #DEFAULT_TIMEOUT}
         * @return this builder
         * @throws IllegalArgumentException if {@code timeout} is zero or negative
         */
        public Builder timeout(Duration timeout) {
            Objects.requireNonNull(timeout, "timeout");
            if (timeout.isZero() || timeout.isNegative()) {
                throw new IllegalArgumentException("timeout must be positive: " + timeout);
            }
            this.timeout = timeout;
            return this;
        }

        /**
         * Sets the source of per-endpoint headers, such as credentials. Defaults to adding no headers.
         *
         * @param authHeadersProvider the provider, called once per HTTP request
         * @return this builder
         */
        public Builder authHeadersProvider(AuthHeadersProvider authHeadersProvider) {
            this.authHeadersProvider = Objects.requireNonNull(authHeadersProvider, "authHeadersProvider");
            return this;
        }

        Builder sleeper(Sleeper sleeper) {
            this.sleeper = Objects.requireNonNull(sleeper, "sleeper");
            return this;
        }

        /**
         * Creates the client.
         *
         * @return a new client with the current settings
         */
        public HttpFacilitatorClient build() {
            return new HttpFacilitatorClient(this);
        }
    }
}
