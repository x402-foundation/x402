package org.x402.http;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpHeaders;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Objects;
import java.util.Optional;

import javax.net.ssl.SSLSession;

/** An {@link HttpResponse} that reports everything from another response but carries a different body. */
final class ForwardingHttpResponse<T> implements HttpResponse<T> {

    private final HttpResponse<?> delegate;
    private final T body;

    /**
     * Creates a response.
     *
     * @param delegate the response whose status, headers, request and connection details are reported
     * @param body the body to report, or {@code null}
     */
    ForwardingHttpResponse(HttpResponse<?> delegate, T body) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.body = body;
    }

    @Override
    public int statusCode() {
        return delegate.statusCode();
    }

    @Override
    public HttpRequest request() {
        return delegate.request();
    }

    /** Intermediate responses, such as redirects, have no body in the JDK client, so they are reported without one. */
    @Override
    public Optional<HttpResponse<T>> previousResponse() {
        return delegate.previousResponse().map(previous -> new ForwardingHttpResponse<>(previous, null));
    }

    @Override
    public HttpHeaders headers() {
        return delegate.headers();
    }

    @Override
    public T body() {
        return body;
    }

    @Override
    public Optional<SSLSession> sslSession() {
        return delegate.sslSession();
    }

    @Override
    public URI uri() {
        return delegate.uri();
    }

    @Override
    public HttpClient.Version version() {
        return delegate.version();
    }

    @Override
    public String toString() {
        return delegate.toString();
    }
}
