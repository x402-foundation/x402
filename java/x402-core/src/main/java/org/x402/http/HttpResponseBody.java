package org.x402.http;

/**
 * A response body chosen by configuration.
 *
 * @param contentType the content type
 * @param body the body; adapters serialize non-strings as JSON
 */
public record HttpResponseBody(String contentType, Object body) {}
