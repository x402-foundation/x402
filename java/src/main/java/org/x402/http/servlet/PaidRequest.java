package org.x402.http.servlet;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpUpgradeHandler;

/**
 * Request passed to the handler of a paid route. It refuses asynchronous processing and protocol upgrades.
 *
 * <p>{@code startAsync()} hands the handler the original, unbuffered response, and an upgrade takes over the
 * connection. Either would let the protected content reach the client before, or without, settlement.
 */
final class PaidRequest extends HttpServletRequestWrapper {

    private static final String UNSUPPORTED =
            "x402 PaymentFilter does not support asynchronous processing or upgrades on paid routes: "
                    + "the response is held back until the payment settles";

    PaidRequest(HttpServletRequest request) {
        super(request);
    }

    @Override
    public boolean isAsyncSupported() {
        return false;
    }

    /**
     * Rejects asynchronous processing.
     *
     * @throws IllegalStateException always
     */
    @Override
    public AsyncContext startAsync() {
        throw new IllegalStateException(UNSUPPORTED);
    }

    /**
     * Rejects asynchronous processing.
     *
     * @throws IllegalStateException always
     */
    @Override
    public AsyncContext startAsync(ServletRequest servletRequest, ServletResponse servletResponse) {
        throw new IllegalStateException(UNSUPPORTED);
    }

    /**
     * Rejects protocol upgrades.
     *
     * @throws ServletException always
     */
    @Override
    public <T extends HttpUpgradeHandler> T upgrade(Class<T> handlerClass) throws ServletException {
        throw new ServletException(UNSUPPORTED);
    }
}
