package org.x402.http;

import org.x402.SettleException;
import org.x402.VerifyException;
import org.x402.http.AuthHeadersProvider.Endpoint;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;
import org.x402.util.Json;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Parses facilitator response bodies.
 *
 * <p>A success body must be a JSON object carrying the fields a caller relies on. Required fields are
 * checked on the JSON tree, before conversion, because a missing {@code boolean} would otherwise silently
 * become {@code false}. Error bodies are decoded leniently: a rejection reason is used when present, and
 * anything else becomes an {@link IOException} quoting a short excerpt of the body.
 */
final class FacilitatorResponses {

    /** Maximum number of characters of a response body quoted in an exception message. */
    static final int EXCERPT_LIMIT = 200;

    private static final Pattern WHITESPACE_OR_CONTROL = Pattern.compile("[\\s\\p{Cntrl}]+");

    private FacilitatorResponses() {
    }

    static VerifyResponse parseVerify(byte[] body) throws IOException {
        JsonNode json = readObject(Endpoint.VERIFY, body);
        if (!isBoolean(json.get("isValid"))) {
            throw invalidData(Endpoint.VERIFY, "isValid must be a boolean", body);
        }
        return convert(Endpoint.VERIFY, json, VerifyResponse.class, body);
    }

    static SettleResponse parseSettle(byte[] body) throws IOException {
        JsonNode json = readObject(Endpoint.SETTLE, body);
        if (!isBoolean(json.get("success"))) {
            throw invalidData(Endpoint.SETTLE, "success must be a boolean", body);
        }
        if (!isText(json.get("transaction")) || !isText(json.get("network"))) {
            throw invalidData(Endpoint.SETTLE, "transaction and network must be strings", body);
        }
        return convert(Endpoint.SETTLE, json, SettleResponse.class, body);
    }

    static SupportedResponse parseSupported(byte[] body) throws IOException {
        JsonNode json = readObject(Endpoint.SUPPORTED, body);
        JsonNode kinds = json.get("kinds");
        if (kinds != null && !kinds.isNull()) {
            if (!kinds.isArray()) {
                throw invalidData(Endpoint.SUPPORTED, "kinds must be an array", body);
            }
            for (JsonNode kind : kinds) {
                if (!isValidKind(kind)) {
                    throw invalidData(Endpoint.SUPPORTED, "every kind needs x402Version, scheme and network", body);
                }
            }
        }
        return convert(Endpoint.SUPPORTED, json, SupportedResponse.class, body);
    }

    /**
     * Extracts the rejection a facilitator reported with a non-2xx {@code /verify} status.
     *
     * @return the rejection, or empty when the body carries no {@code invalidReason}
     */
    static Optional<VerifyException> verifyRejection(byte[] body) {
        JsonNode json = readObjectOrNull(body);
        String reason = text(json, "invalidReason");
        if (reason == null || reason.isEmpty()) {
            return Optional.empty();
        }
        return Optional.of(new VerifyException(reason, text(json, "payer"), text(json, "invalidMessage")));
    }

    /**
     * Extracts the rejection a facilitator reported with a non-2xx {@code /settle} status.
     *
     * @return the rejection, or empty when the body carries no {@code errorReason}
     */
    static Optional<SettleException> settleRejection(int status, byte[] body) {
        JsonNode json = readObjectOrNull(body);
        String reason = text(json, "errorReason");
        if (reason == null || reason.isEmpty()) {
            return Optional.empty();
        }
        String detail = "facilitator returned " + status;
        String errorMessage = text(json, "errorMessage");
        if (errorMessage != null && !errorMessage.isEmpty()) {
            detail = detail + ": " + errorMessage;
        }
        return Optional.of(new SettleException(
                reason,
                text(json, "payer"),
                orEmpty(text(json, "network")),
                orEmpty(text(json, "transaction")),
                detail));
    }

    static IOException unexpectedStatus(Endpoint endpoint, int status, byte[] body) {
        return new IOException(
                "Facilitator " + operation(endpoint) + " failed (HTTP " + status + "): " + excerpt(body));
    }

    /**
     * Returns a single-line excerpt of a response body for exception messages: whitespace and control characters
     * collapse to one space and the result is cut to {@value #EXCERPT_LIMIT} characters.
     */
    static String excerpt(byte[] body) {
        String compact = WHITESPACE_OR_CONTROL.matcher(new String(body, StandardCharsets.UTF_8)).replaceAll(" ")
                .strip();
        if (compact.isEmpty()) {
            return "<empty response>";
        }
        if (compact.length() <= EXCERPT_LIMIT) {
            return compact;
        }
        return compact.substring(0, EXCERPT_LIMIT - 3) + "...";
    }

    private static JsonNode readObject(Endpoint endpoint, byte[] body) throws IOException {
        JsonNode json;
        try {
            json = Json.read(body, JsonNode.class);
        } catch (IOException e) {
            throw new IOException(
                    "Facilitator " + operation(endpoint) + " returned invalid JSON: " + excerpt(body), e);
        }
        if (json == null || !json.isObject()) {
            throw invalidData(endpoint, "expected a JSON object", body);
        }
        return json;
    }

    private static JsonNode readObjectOrNull(byte[] body) {
        try {
            JsonNode json = Json.read(body, JsonNode.class);
            return json != null && json.isObject() ? json : null;
        } catch (IOException e) {
            // An unparseable error body is reported by the caller as an unexpected status with an excerpt.
            return null;
        }
    }

    private static <T> T convert(Endpoint endpoint, JsonNode json, Class<T> type, byte[] body)
            throws IOException {
        try {
            return Json.convert(json, type);
        } catch (IllegalArgumentException e) {
            throw new IOException(
                    "Facilitator " + operation(endpoint) + " returned invalid data: " + excerpt(body), e);
        }
    }

    private static IOException invalidData(Endpoint endpoint, String problem, byte[] body) {
        return new IOException(
                "Facilitator " + operation(endpoint) + " returned invalid data (" + problem + "): " + excerpt(body));
    }

    private static boolean isValidKind(JsonNode kind) {
        if (!kind.isObject()) {
            return false;
        }
        JsonNode version = kind.get("x402Version");
        return version != null
                && version.isIntegralNumber()
                && version.canConvertToInt()
                && isNonEmptyText(kind.get("scheme"))
                && isNonEmptyText(kind.get("network"));
    }

    private static boolean isBoolean(JsonNode node) {
        return node != null && node.isBoolean();
    }

    private static boolean isText(JsonNode node) {
        return node != null && node.isTextual();
    }

    private static boolean isNonEmptyText(JsonNode node) {
        return isText(node) && !node.textValue().isEmpty();
    }

    private static String text(JsonNode json, String field) {
        if (json == null) {
            return null;
        }
        JsonNode node = json.get(field);
        return isText(node) ? node.textValue() : null;
    }

    private static String orEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String operation(Endpoint endpoint) {
        return endpoint.name().toLowerCase(Locale.ROOT);
    }
}
