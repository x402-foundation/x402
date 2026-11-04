package org.x402.http.servlet;

import jakarta.servlet.http.HttpServletResponse;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Headers present on the real response before the protected handler ran, typically set by upstream filters
 * such as CORS. {@link PaymentFilter} restores them after resetting the response, so a 402 keeps them while
 * everything the handler set is dropped.
 *
 * <p>Immutable.
 */
final class HeaderSnapshot {

    private final Map<String, List<String>> headers;

    private HeaderSnapshot(Map<String, List<String>> headers) {
        this.headers = headers;
    }

    /**
     * Captures the headers currently set on a response.
     *
     * @param response the real response
     * @return the snapshot
     */
    static HeaderSnapshot of(HttpServletResponse response) {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        for (String name : response.getHeaderNames()) {
            headers.put(name, List.copyOf(response.getHeaders(name)));
        }
        return new HeaderSnapshot(Collections.unmodifiableMap(headers));
    }

    /**
     * Resets the response, discarding its status, headers and buffer, and adds back the captured headers.
     *
     * @param response the real response, not yet committed
     * @throws IllegalStateException if the response has been committed
     */
    void resetTo(HttpServletResponse response) {
        response.reset();
        headers.forEach((name, values) -> {
            for (String value : values) {
                // Some containers re-add headers such as a new session cookie on reset.
                if (!response.getHeaders(name).contains(value)) {
                    response.addHeader(name, value);
                }
            }
        });
    }
}
