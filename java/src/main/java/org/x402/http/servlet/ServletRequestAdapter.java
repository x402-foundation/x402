package org.x402.http.servlet;

import org.x402.http.HttpRequestAdapter;

import jakarta.servlet.http.HttpServletRequest;

import java.util.Objects;
import java.util.Optional;

/**
 * {@link HttpRequestAdapter} over a servlet request. Paths are relative to the servlet context, so routes are
 * declared without the context path.
 *
 * <p>{@link #path()} is the raw request URI, which the container does not decode or normalize.
 * {@link #decodedPath()} is the decoded, canonical path the container dispatched on. Matching both means a
 * route cannot be bypassed through encodings the container resolves, such as {@code %2e%2e} or {@code ;}
 * parameters.
 */
final class ServletRequestAdapter implements HttpRequestAdapter {

    private final HttpServletRequest request;

    ServletRequestAdapter(HttpServletRequest request) {
        this.request = Objects.requireNonNull(request, "request");
    }

    @Override
    public String method() {
        return request.getMethod();
    }

    @Override
    public String path() {
        String uri = request.getRequestURI();
        String contextPath = request.getContextPath();
        if (uri == null) {
            return "/";
        }
        if (contextPath == null || contextPath.isEmpty() || !uri.startsWith(contextPath)) {
            return uri;
        }
        String withinContext = uri.substring(contextPath.length());
        // Keep the full URI when the prefix only matches part of a segment, e.g. "/shopping" for context "/shop".
        return withinContext.isEmpty() || withinContext.charAt(0) == '/' ? withinContext : uri;
    }

    @Override
    public Optional<String> decodedPath() {
        String servletPath = request.getServletPath();
        String pathInfo = request.getPathInfo();
        String decoded = (servletPath == null ? "" : servletPath) + (pathInfo == null ? "" : pathInfo);
        return decoded.isEmpty() ? Optional.empty() : Optional.of(decoded);
    }

    @Override
    public String url() {
        StringBuffer url = request.getRequestURL();
        String query = request.getQueryString();
        if (query != null) {
            url.append('?').append(query);
        }
        return url.toString();
    }

    @Override
    public Optional<String> header(String name) {
        return Optional.ofNullable(request.getHeader(name));
    }
}
