package org.x402.http;

import java.util.Map;

/**
 * Transport data handed to hooks and settlement.
 *
 * @param request the request
 * @param responseBody the buffered handler response, when settling after the handler
 * @param responseHeaders the handler's response headers, when settling after the handler; read
 *     for {@code Settlement-Overrides}
 */
public record HttpTransportContext(
    HttpRequestContext request, byte[] responseBody, Map<String, String> responseHeaders) {}
