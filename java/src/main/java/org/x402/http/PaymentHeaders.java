package org.x402.http;

import org.x402.util.Json;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;

/**
 * Names and codec of the x402 v2 HTTP headers.
 *
 * <p>Header values are standard base64 (RFC 4648 section 4, padded) of UTF-8 JSON, as defined in
 * {@code specs/transports-v2/http.md}.
 */
public final class PaymentHeaders {

    /** Response header carrying the {@code PaymentRequired} message of a 402 response. */
    public static final String PAYMENT_REQUIRED = "PAYMENT-REQUIRED";

    /** Request header carrying the client's {@code PaymentPayload}. */
    public static final String PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";

    /** Response header carrying the {@code SettleResponse}. */
    public static final String PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

    private PaymentHeaders() {
    }

    /**
     * Encodes a value as a header value.
     *
     * @param value the value to encode
     * @return base64 of the value's JSON
     */
    public static String encode(Object value) {
        Objects.requireNonNull(value, "value");
        return Base64.getEncoder().encodeToString(Json.write(value).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Decodes a header value.
     *
     * @param header the header value
     * @param type the expected type
     * @param <T> the expected type
     * @return the decoded value
     * @throws IllegalArgumentException if the value is not base64 of a JSON object of {@code type}
     */
    public static <T> T decode(String header, Class<T> type) {
        Objects.requireNonNull(header, "header");
        byte[] json;
        try {
            json = Base64.getDecoder().decode(header.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Header is not valid base64", e);
        }
        String text = new String(json, StandardCharsets.UTF_8).trim();
        if (!text.startsWith("{")) {
            throw new IllegalArgumentException("Header does not contain a JSON object");
        }
        try {
            return Json.read(text, type);
        } catch (IOException e) {
            throw new IllegalArgumentException("Header JSON does not match " + type.getSimpleName(), e);
        }
    }
}
