package org.x402.http;

import org.x402.PaymentException;
import org.x402.X402;
import org.x402.X402Client;
import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequired;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.InputStream;
import java.lang.System.Logger.Level;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandler;
import java.net.http.HttpResponse.BodySubscriber;
import java.net.http.HttpResponse.BodySubscribers;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.Optional;

/**
 * An HTTP client that pays for x402-protected resources automatically, built on {@link java.net.http.HttpClient}.
 *
 * <p>{@link #send} sends a request and, if the server answers {@code 402 Payment Required}, pays and sends it again:
 * <ol>
 *   <li>The {@code PaymentRequired} is read from the {@code PAYMENT-REQUIRED} header. Without that header, a JSON
 *       body with {@code "x402Version": 2} of at most 1 MiB is accepted instead.</li>
 *   <li>The {@link X402Client} selects an option and signs a {@link PaymentPayload}.</li>
 *   <li>The request that received the 402 is copied with all its headers, its body publisher and its settings,
 *       and sent once more with the payload in the {@code PAYMENT-SIGNATURE} header.</li>
 *   <li>That second response is returned whatever its status. A second 402 is returned, not retried, so a request
 *       is never paid more than once.</li>
 * </ol>
 * Any status other than 402 is returned untouched, with the body produced by the caller's handler.
 *
 * <pre>{@code
 * X402HttpClient http = new X402HttpClient(x402Client);
 * HttpResponse<String> response = http.send(
 *         HttpRequest.newBuilder(URI.create("https://api.example.com/weather")).build(),
 *         HttpResponse.BodyHandlers.ofString());
 * Optional<SettleResponse> settlement = X402HttpClient.settleResponse(response);
 * }</pre>
 *
 * <p>A paid request is sent twice, so its body publisher must support being subscribed to twice. Every
 * {@link HttpRequest.BodyPublishers} factory does, except {@code ofInputStream} with a supplier that returns the
 * same stream each time. Redirects, timeouts and authentication follow the injected {@link HttpClient}; the request's
 * own timeout applies to each of the two attempts. If the client follows redirects, the paid request goes straight
 * to the URI that answered 402, with the method and body the redirect left, so a redirecting origin never receives
 * the payment.
 *
 * <p>Instances are immutable, and thread-safe whenever the wrapped {@link X402Client} is.
 */
public final class X402HttpClient {

    /** The largest 402 response body read when the {@code PAYMENT-REQUIRED} header is absent. */
    static final int MAX_PAYMENT_REQUIRED_BODY_BYTES = 1 << 20;

    /** The x402 v1 name of the settlement response header, still read as a fallback. */
    private static final String LEGACY_PAYMENT_RESPONSE = "X-PAYMENT-RESPONSE";
    private static final int PAYMENT_REQUIRED_STATUS = 402;
    private static final System.Logger LOGGER = System.getLogger(X402HttpClient.class.getName());

    private final X402Client client;
    private final HttpClient httpClient;

    /**
     * Creates a client that sends requests with a new HTTP/1.1 {@link HttpClient}.
     *
     * <p>HTTP/1.1 is the default because the JDK's HTTP/2 client sends an {@code h2c} upgrade on cleartext
     * {@code http://} URLs, which some servers (e.g. Next.js) answer by closing the connection. Pass an
     * {@link HttpClient} to {@link #X402HttpClient(X402Client, HttpClient)} to use HTTP/2.
     *
     * @param client the payment client that selects and signs payments
     */
    public X402HttpClient(X402Client client) {
        this(client, HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build());
    }

    /**
     * Creates a client that sends requests with the given {@link HttpClient}.
     *
     * @param client the payment client that selects and signs payments
     * @param httpClient the HTTP client used for both the initial and the paid request
     */
    public X402HttpClient(X402Client client, HttpClient httpClient) {
        this.client = Objects.requireNonNull(client, "client");
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
    }

    /**
     * Sends a request, paying for it if the server answers 402.
     *
     * @param request the request; its body publisher must be replayable, see the class description
     * @param responseBodyHandler the handler for the body of the response returned to the caller; it is not used
     *     for the body of a 402 that triggers a payment
     * @param <T> the response body type
     * @return the response to the request, or the response to the paid request if a payment was made
     * @throws PaymentException with {@link PaymentException#INVALID_PAYMENT_REQUIRED} if a 402 carries no valid
     *     {@code PaymentRequired}, or with the reason from {@link X402Client} if no offered option can be paid
     * @throws IOException if sending or receiving fails
     * @throws InterruptedException if the calling thread is interrupted while waiting for a response
     */
    public <T> HttpResponse<T> send(HttpRequest request, BodyHandler<T> responseBodyHandler)
            throws IOException, InterruptedException {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(responseBodyHandler, "responseBodyHandler");

        HttpResponse<FirstResponse<T>> response = httpClient.send(request, firstResponseHandler(responseBodyHandler));
        FirstResponse<T> first = response.body();
        if (first instanceof Delivered<T> delivered) {
            return new ForwardingHttpResponse<>(response, delivered.body());
        }

        PaymentRequired paymentRequired = readPaymentRequired(response, ((Unpaid<T>) first).body());
        PaymentRequirements selected = client.selectPaymentRequirements(paymentRequired);
        PaymentPayload payload = client.createPaymentPayload(paymentRequired, selected);
        // After redirects this is the hop that answered 402.
        HttpRequest answered = response.request();
        // The query string and user info are left out because they may carry credentials.
        LOGGER.log(Level.DEBUG, () -> "Paying for " + answered.method() + " " + answered.uri().getHost()
                + answered.uri().getRawPath() + " with " + selected.scheme() + " on " + selected.network() + ": "
                + selected.amount() + " of " + selected.asset());

        HttpRequest paid = HttpRequest.newBuilder(answered, (name, value) -> true)
                .setHeader(PaymentHeaders.PAYMENT_SIGNATURE, PaymentHeaders.encode(payload))
                .build();
        return httpClient.send(paid, responseBodyHandler);
    }

    /**
     * Decodes the settlement result a server attached to a paid response.
     *
     * <p>Reads the {@code PAYMENT-RESPONSE} header, falling back to the x402 v1 name {@code X-PAYMENT-RESPONSE}.
     * A failed settlement is reported as a {@link SettleResponse} with {@code success == false}, typically on a
     * 402 response.
     *
     * @param response a response returned by {@link #send}, or any other response
     * @return the settlement result, or empty if the response carries neither header
     * @throws PaymentException with {@link PaymentException#INVALID_PAYMENT_RESPONSE} if the header is not
     *     base64-encoded JSON of a {@code SettleResponse}
     */
    public static Optional<SettleResponse> settleResponse(HttpResponse<?> response) {
        Objects.requireNonNull(response, "response");
        Optional<String> header = response.headers().firstValue(PaymentHeaders.PAYMENT_RESPONSE)
                .or(() -> response.headers().firstValue(LEGACY_PAYMENT_RESPONSE));
        if (header.isEmpty()) {
            return Optional.empty();
        }
        try {
            return Optional.of(PaymentHeaders.decode(header.get(), SettleResponse.class));
        } catch (IllegalArgumentException e) {
            throw new PaymentException(PaymentException.INVALID_PAYMENT_RESPONSE,
                    "payment response header is malformed: " + e.getMessage(), e);
        }
    }

    /**
     * Hands a 402 body over as an unread stream, so it can be read with a size limit or skipped, and any other
     * body to the caller's handler.
     */
    private static <T> BodyHandler<FirstResponse<T>> firstResponseHandler(BodyHandler<T> responseBodyHandler) {
        return info -> {
            if (info.statusCode() == PAYMENT_REQUIRED_STATUS) {
                return BodySubscribers.mapping(BodySubscribers.ofInputStream(), Unpaid<T>::new);
            }
            BodySubscriber<T> delegate = responseBodyHandler.apply(info);
            return BodySubscribers.mapping(delegate, Delivered<T>::new);
        };
    }

    private static PaymentRequired readPaymentRequired(HttpResponse<?> response, InputStream body) throws IOException {
        try (InputStream in = body) {
            Optional<String> header = response.headers().firstValue(PaymentHeaders.PAYMENT_REQUIRED);
            if (header.isPresent()) {
                return decodeHeader(header.get());
            }
            byte[] bytes = in.readNBytes(MAX_PAYMENT_REQUIRED_BODY_BYTES + 1);
            if (bytes.length > MAX_PAYMENT_REQUIRED_BODY_BYTES) {
                throw invalid("402 response has no PAYMENT-REQUIRED header and its body exceeds "
                        + MAX_PAYMENT_REQUIRED_BODY_BYTES + " bytes", null);
            }
            return decodeBody(bytes);
        }
    }

    private static PaymentRequired decodeHeader(String header) {
        try {
            return PaymentHeaders.decode(header, PaymentRequired.class);
        } catch (IllegalArgumentException e) {
            throw invalid("PAYMENT-REQUIRED header is malformed: " + e.getMessage(), e);
        }
    }

    private static PaymentRequired decodeBody(byte[] bytes) {
        JsonNode tree;
        try {
            tree = Json.readTree(new String(bytes, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw invalid("402 response has no PAYMENT-REQUIRED header and its body is not JSON", e);
        }
        if (!tree.isObject()) {
            throw invalid("402 response has no PAYMENT-REQUIRED header and its body is not a JSON object", null);
        }
        JsonNode version = tree.path("x402Version");
        if (!version.isIntegralNumber() || version.asLong() != X402.PROTOCOL_VERSION) {
            throw invalid("402 response has no PAYMENT-REQUIRED header and its body is not an x402 v"
                    + X402.PROTOCOL_VERSION + " PaymentRequired (x402Version: "
                    + (version.isMissingNode() ? "missing" : version.toString()) + ")", null);
        }
        try {
            return Json.convert(tree, PaymentRequired.class);
        } catch (IllegalArgumentException e) {
            throw invalid("402 response body is not a valid PaymentRequired: " + e.getMessage(), e);
        }
    }

    private static PaymentException invalid(String message, Throwable cause) {
        return new PaymentException(PaymentException.INVALID_PAYMENT_REQUIRED, message, cause);
    }

    /** What the first attempt produced: the caller's body, or the unread body of a 402. */
    private sealed interface FirstResponse<T> permits Delivered, Unpaid {
    }

    /** A non-402 response body, produced by the caller's handler. */
    private record Delivered<T>(T body) implements FirstResponse<T> {
    }

    /** The body of a 402 response, not yet read. */
    private record Unpaid<T>(InputStream body) implements FirstResponse<T> {
    }
}
