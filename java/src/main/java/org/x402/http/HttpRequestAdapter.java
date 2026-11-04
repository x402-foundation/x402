package org.x402.http;

import java.util.Optional;

/**
 * Read-only view of an incoming HTTP request, implemented once per web framework so that
 * {@link HttpResourceServer} stays framework-independent.
 *
 * <p>Route matching uses both {@link #path()} and {@link #decodedPath()}. Implementations should supply the
 * decoded path whenever the framework routes on it, so a route cannot be bypassed through either
 * representation.
 *
 * <p>Implementations are used by one request-processing thread at a time and need not be thread-safe.
 */
public interface HttpRequestAdapter {

    /**
     * Returns the request method.
     *
     * @return the method, e.g. {@code "GET"}; matched case-insensitively
     */
    String method();

    /**
     * Returns the request path as sent by the client, before percent-decoding, relative to the application
     * root that routes are declared against.
     *
     * @return the escaped path, e.g. {@code "/api/users/x%2Fy"}; a query string, if present, is ignored
     */
    String path();

    /**
     * Returns the path the framework routes on after decoding it, e.g. a servlet's
     * {@code getServletPath() + getPathInfo()}.
     *
     * @return the decoded routing path, or empty when the framework does not expose one
     */
    default Optional<String> decodedPath() {
        return Optional.empty();
    }

    /**
     * Returns the absolute request URL, advertised as the resource when the route does not configure one.
     *
     * @return the URL, e.g. {@code "https://api.example.com/weather?city=Tallinn"}
     */
    String url();

    /**
     * Returns the first value of a request header.
     *
     * @param name the header name, matched case-insensitively
     * @return the value, or empty when the header is absent
     */
    Optional<String> header(String name);
}
