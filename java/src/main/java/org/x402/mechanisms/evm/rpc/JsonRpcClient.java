package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;
import org.x402.util.BoundedBodySubscriber;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;

/**
 * A minimal JSON-RPC 2.0 client over HTTP for Ethereum nodes.
 *
 * <p>Each {@link #call(String, List)} sends one request and validates the response strictly, because the node is
 * an external service: the whole response must arrive within the request timeout, the HTTP status must be 2xx, the
 * body at most {@link #MAX_RESPONSE_BYTES} of JSON, the {@code jsonrpc} version {@code "2.0"} and the {@code id} the
 * one sent. Exception messages name the method but
 * never the endpoint, which often embeds an API key, nor the parameters, which may hold signed transactions.
 *
 * <p>Instances are immutable apart from the request id counter and are thread-safe.
 */
final class JsonRpcClient {

    /** Responses larger than this are rejected so a misbehaving node cannot exhaust memory. */
    static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    private static final int MAX_BODY_SNIPPET = 200;
    /** Quantities are at most 256 bits; leading zeros are tolerated although nodes should not send them. */
    private static final Pattern QUANTITY = Pattern.compile("0x[0-9a-fA-F]{1,64}");
    private static final Pattern DATA = Pattern.compile("0x([0-9a-fA-F]{2})*");

    private final URI endpoint;
    private final HttpClient httpClient;
    private final Duration requestTimeout;
    private final AtomicLong nextId = new AtomicLong(1);

    /**
     * Creates a client.
     *
     * @param endpoint the node's HTTP(S) JSON-RPC endpoint
     * @param httpClient the HTTP client to send requests with
     * @param requestTimeout the time each request may take, from sending it to receiving the last body byte
     */
    JsonRpcClient(URI endpoint, HttpClient httpClient, Duration requestTimeout) {
        this.endpoint = Objects.requireNonNull(endpoint, "endpoint");
        this.httpClient = Objects.requireNonNull(httpClient, "httpClient");
        this.requestTimeout = Objects.requireNonNull(requestTimeout, "requestTimeout");
    }

    /**
     * Calls a JSON-RPC method.
     *
     * @param method the method, e.g. {@code "eth_chainId"}
     * @param params the positional parameters, serialized with {@link Json}
     * @return the {@code result} member, a {@code NullNode} when the node returned {@code null}
     * @throws JsonRpcException if the node returned an error object
     * @throws HttpStatusException if the HTTP status is not 2xx
     * @throws HttpTimeoutException if the complete response did not arrive within the request timeout
     * @throws IOException if the node cannot be reached or the response is not a valid JSON-RPC response
     * @throws InterruptedException if the calling thread is interrupted
     */
    JsonNode call(String method, List<?> params) throws IOException, InterruptedException {
        return call(method, params, requestTimeout);
    }

    /**
     * Calls a JSON-RPC method with a shorter time limit than the request timeout, e.g. the time left before a
     * deadline.
     *
     * @param method the method
     * @param params the positional parameters
     * @param timeout the time the request may take, capped at the request timeout; positive
     * @return the {@code result} member, a {@code NullNode} when the node returned {@code null}
     * @throws IllegalArgumentException if {@code timeout} is zero or negative
     * @throws JsonRpcException if the node returned an error object
     * @throws HttpStatusException if the HTTP status is not 2xx
     * @throws HttpTimeoutException if the complete response did not arrive in time
     * @throws IOException if the node cannot be reached or the response is not a valid JSON-RPC response
     * @throws InterruptedException if the calling thread is interrupted
     */
    JsonNode call(String method, List<?> params, Duration timeout) throws IOException, InterruptedException {
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(params, "params");
        Objects.requireNonNull(timeout, "timeout");
        if (timeout.isNegative() || timeout.isZero()) {
            throw new IllegalArgumentException("timeout must be positive");
        }
        Duration limit = timeout.compareTo(requestTimeout) < 0 ? timeout : requestTimeout;
        long id = nextId.getAndIncrement();
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("jsonrpc", "2.0");
        request.put("id", id);
        request.put("method", method);
        request.put("params", params);
        HttpRequest httpRequest = HttpRequest.newBuilder(endpoint)
                .timeout(limit)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(Json.write(request)))
                .build();

        HttpResponse<byte[]> response = send(method, httpRequest, limit);
        byte[] body = response.body();
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new HttpStatusException(
                    response.statusCode(), method + ": HTTP status " + response.statusCode() + snippet(body));
        }
        return result(method, id, body);
    }

    /**
     * Decodes a JSON-RPC quantity, {@code 0x} followed by at most 64 hex digits, e.g. {@code "0x2a"}.
     *
     * @param node the JSON value
     * @param what a description for error messages, e.g. {@code "eth_chainId result"}
     * @return the non-negative value
     * @throws IOException if the value is not a quantity string
     */
    static BigInteger decodeQuantity(JsonNode node, String what) throws IOException {
        if (node == null || !node.isTextual() || !QUANTITY.matcher(node.textValue()).matches()) {
            throw new IOException(what + " is not a hex quantity");
        }
        return new BigInteger(node.textValue().substring(2), 16);
    }

    /**
     * Decodes JSON-RPC unformatted data, {@code 0x} followed by an even number of hex digits.
     *
     * @param node the JSON value
     * @param what a description for error messages
     * @return the bytes, possibly empty
     * @throws IOException if the value is not a data string
     */
    static byte[] decodeData(JsonNode node, String what) throws IOException {
        if (node == null || !node.isTextual() || !DATA.matcher(node.textValue()).matches()) {
            throw new IOException(what + " is not 0x-prefixed hex data");
        }
        return Hex.decode(node.textValue());
    }

    /**
     * Sends a request and reads the whole body within the request timeout. {@link HttpRequest#timeout} alone only
     * bounds the wait for the response headers, so a node that stalls while sending the body could otherwise block
     * the caller forever.
     */
    private HttpResponse<byte[]> send(String method, HttpRequest request, Duration limit)
            throws IOException, InterruptedException {
        CompletableFuture<HttpResponse<byte[]>> pending =
                httpClient.sendAsync(request, info -> new BoundedBodySubscriber(MAX_RESPONSE_BYTES));
        try {
            return pending.get(limit.toNanos(), TimeUnit.NANOSECONDS);
        } catch (TimeoutException e) {
            pending.cancel(true);
            throw timeout(method, limit, e);
        } catch (InterruptedException e) {
            pending.cancel(true);
            throw e;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof HttpTimeoutException) {
                throw timeout(method, limit, cause);
            }
            if (cause instanceof BoundedBodySubscriber.TooLargeException) {
                throw new IOException(method + ": response exceeds " + MAX_RESPONSE_BYTES + " bytes", cause);
            }
            throw new IOException(method + ": request failed: " + cause, cause);
        }
    }

    private static HttpTimeoutException timeout(String method, Duration limit, Throwable cause) {
        HttpTimeoutException timeout = new HttpTimeoutException(method + ": no response within " + limit);
        timeout.initCause(cause);
        return timeout;
    }

    private static JsonNode result(String method, long id, byte[] body) throws IOException {
        JsonNode root;
        try {
            root = Json.readTree(new String(body, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IOException(method + ": response is not JSON" + snippet(body), e);
        }
        if (root == null || !root.isObject()) {
            throw new IOException(method + ": response is not a JSON-RPC object" + snippet(body));
        }
        JsonNode version = root.get("jsonrpc");
        if (version == null || !"2.0".equals(version.textValue())) {
            throw new IOException(method + ": response is not JSON-RPC 2.0");
        }
        JsonNode responseId = root.get("id");
        boolean idMatches = responseId != null && responseId.isIntegralNumber() && responseId.asLong() == id;
        JsonNode error = root.get("error");
        if (error != null && !error.isNull()) {
            // A node that could not read the request answers with id null; any other id must be ours
            if (!idMatches && responseId != null && !responseId.isNull()) {
                throw new IOException(method + ": response id does not match the request");
            }
            throw rpcError(method, error);
        }
        if (!idMatches) {
            throw new IOException(method + ": response id does not match the request");
        }
        JsonNode result = root.get("result");
        if (result == null) {
            throw new IOException(method + ": response has neither result nor error");
        }
        return result;
    }

    private static IOException rpcError(String method, JsonNode error) {
        JsonNode code = error.get("code");
        JsonNode message = error.get("message");
        if (!error.isObject() || code == null || !code.isIntegralNumber() || !code.canConvertToInt()
                || message == null || !message.isTextual()) {
            return new IOException(method + ": malformed JSON-RPC error object");
        }
        JsonNode data = error.get("data");
        String dataText = null;
        if (data != null && data.isTextual()) {
            dataText = data.textValue();
        } else if (data != null && !data.isNull()) {
            dataText = data.toString();
        }
        return new JsonRpcException(method, code.intValue(), message.textValue(), dataText);
    }

    private static String snippet(byte[] body) {
        if (body.length == 0) {
            return "";
        }
        String text = new String(body, StandardCharsets.UTF_8).strip();
        if (text.length() > MAX_BODY_SNIPPET) {
            text = text.substring(0, MAX_BODY_SNIPPET) + "...";
        }
        return ": " + text;
    }
}
