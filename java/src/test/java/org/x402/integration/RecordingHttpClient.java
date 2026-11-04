package org.x402.integration;

import org.x402.http.PaymentHeaders;

import java.io.IOException;
import java.net.Authenticator;
import java.net.CookieHandler;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;

/**
 * An {@link HttpClient} that sends through a default client and records every exchange, so a test sees both the
 * unpaid request and the paid retry that {@code X402HttpClient} makes. Only the synchronous {@link #send} is
 * supported. Thread-safe.
 */
final class RecordingHttpClient extends HttpClient {

    /**
     * One request and the status it was answered with.
     *
     * @param paymentSignature the request's {@code PAYMENT-SIGNATURE} header, or {@code null} if it had none
     * @param status the response status
     */
    record Exchange(String paymentSignature, int status) {
    }

    private final HttpClient delegate = HttpClient.newHttpClient();
    private final List<Exchange> exchanges = new CopyOnWriteArrayList<>();

    List<Exchange> exchanges() {
        return List.copyOf(exchanges);
    }

    @Override
    public <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler)
            throws IOException, InterruptedException {
        HttpResponse<T> response = delegate.send(request, handler);
        exchanges.add(new Exchange(
                request.headers().firstValue(PaymentHeaders.PAYMENT_SIGNATURE).orElse(null), response.statusCode()));
        return response;
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> handler) {
        throw new UnsupportedOperationException("sendAsync");
    }

    @Override
    public <T> CompletableFuture<HttpResponse<T>> sendAsync(HttpRequest request, HttpResponse.BodyHandler<T> handler,
            HttpResponse.PushPromiseHandler<T> pushPromiseHandler) {
        throw new UnsupportedOperationException("sendAsync");
    }

    @Override
    public Optional<CookieHandler> cookieHandler() {
        return delegate.cookieHandler();
    }

    @Override
    public Optional<Duration> connectTimeout() {
        return delegate.connectTimeout();
    }

    @Override
    public Redirect followRedirects() {
        return delegate.followRedirects();
    }

    @Override
    public Optional<ProxySelector> proxy() {
        return delegate.proxy();
    }

    @Override
    public SSLContext sslContext() {
        return delegate.sslContext();
    }

    @Override
    public SSLParameters sslParameters() {
        return delegate.sslParameters();
    }

    @Override
    public Optional<Authenticator> authenticator() {
        return delegate.authenticator();
    }

    @Override
    public Version version() {
        return delegate.version();
    }

    @Override
    public Optional<Executor> executor() {
        return delegate.executor();
    }
}
