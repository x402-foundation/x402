package org.x402.http;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * A complete HTTP response that a framework adapter writes as is, e.g. a 402 with a {@code PAYMENT-REQUIRED}
 * header.
 *
 * <p>Instances are immutable and thread-safe.
 *
 * @param status the HTTP status code, between 100 and 599
 * @param headers response headers to set, replacing existing values, in insertion order
 * @param body the response body; JSON bodies are UTF-8 and declared by a {@code Content-Type} header
 */
public record HttpResponseInstructions(int status, Map<String, String> headers, String body) {

    /**
     * Creates response instructions, copying {@code headers}.
     *
     * @throws IllegalArgumentException if {@code status} is outside 100 to 599
     */
    public HttpResponseInstructions {
        if (status < 100 || status > 599) {
            throw new IllegalArgumentException("Invalid HTTP status: " + status);
        }
        headers = Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(headers, "headers")));
        Objects.requireNonNull(body, "body");
    }

    /**
     * Returns the body encoded as UTF-8.
     *
     * @return a new array holding the body bytes
     */
    public byte[] bodyBytes() {
        return body.getBytes(StandardCharsets.UTF_8);
    }
}
