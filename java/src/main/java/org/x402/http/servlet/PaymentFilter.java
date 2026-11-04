package org.x402.http.servlet;

import org.x402.http.HttpResourceServer;
import org.x402.http.HttpResponseInstructions;
import org.x402.http.ProcessResult;
import org.x402.http.SettlementResult;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.Objects;

/**
 * Servlet filter that charges for the routes of an {@link HttpResourceServer}.
 *
 * <p>For each request:
 *
 * <ol>
 *   <li>A request that matches no paid route, including a CORS preflight {@code OPTIONS} on a route declared
 *       without a method, passes through untouched.</li>
 *   <li>A request without a valid payment is answered by {@link HttpResourceServer#processRequest}, typically
 *       with a 402, and never reaches the handler.</li>
 *   <li>A verified request runs the rest of the chain with its response buffered. The payload and requirements
 *       are available to the handler as request attributes {@link #PAYMENT_PAYLOAD_ATTRIBUTE} and
 *       {@link #PAYMENT_REQUIREMENTS_ATTRIBUTE}.</li>
 *   <li>If the handler's status is 400 or above, nothing is settled and its response is released as is. As the
 *       servlet specification requires, a resource the handler includes cannot change the status, the content
 *       length or the headers, send an error or a redirect, or reset the response.</li>
 *   <li>Otherwise the payment is settled. On success the response is released with a {@code PAYMENT-RESPONSE}
 *       header and {@code private} merged into {@code Cache-Control}. On failure the handler's body, status and
 *       headers are discarded and a 402 {@code {"error":"settlement_failed"}} with {@code PAYMENT-RESPONSE} and
 *       {@code Cache-Control: no-store} is sent instead.</li>
 *   <li>If the handler throws, nothing is settled. If the handler or settlement throws, the handler's response is
 *       discarded and the exception propagates to the container.</li>
 * </ol>
 *
 * <p>The protected body is therefore never delivered unless the payment settled or the handler itself reported
 * an error. Headers set before the filter ran, e.g. by a CORS filter, are kept on every response, while a
 * settlement-failure 402 drops every header the handler set, cookies included.
 *
 * <p>Paid routes must be handled synchronously: the handler sees a request that rejects {@code startAsync} and
 * protocol upgrades, because both would bypass the buffer. The whole response body is held in memory. The
 * filter must not be bypassed by a handler that unwraps the response.
 *
 * <p>Map the filter for {@code FORWARD} as well as {@code REQUEST} dispatches. Routes are matched against the
 * dispatched path, so without {@code FORWARD} a free URL that forwards to a paid path, e.g. through a rewrite
 * filter or a Spring {@code forward:} view, serves it unpaid. A forward inside a request the filter already
 * charged for is recognized by {@link #PAYMENT_PAYLOAD_ATTRIBUTE} and not charged again. {@code INCLUDE} does
 * not help: an include keeps the original request path, so declare the URL clients request as the paid route.
 *
 * <pre>{@code
 * HttpResourceServer payments = new HttpResourceServer(resourceServer, routes);
 * FilterRegistration.Dynamic registration = servletContext.addFilter("x402", new PaymentFilter(payments));
 * registration.addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST, DispatcherType.FORWARD), false, "/*");
 * }</pre>
 *
 * <p>Instances are thread-safe.
 */
public final class PaymentFilter implements Filter {

    /** Request attribute holding the verified {@link org.x402.types.PaymentPayload}. */
    public static final String PAYMENT_PAYLOAD_ATTRIBUTE = "org.x402.paymentPayload";

    /** Request attribute holding the {@link org.x402.types.PaymentRequirements} the payment matched. */
    public static final String PAYMENT_REQUIREMENTS_ATTRIBUTE = "org.x402.paymentRequirements";

    private static final String CACHE_CONTROL = "Cache-Control";
    private static final System.Logger LOG = System.getLogger(PaymentFilter.class.getName());

    private final HttpResourceServer server;

    /**
     * Creates a payment filter.
     *
     * @param server the HTTP resource server; initialized by {@link #init(FilterConfig)} unless it already is
     */
    public PaymentFilter(HttpResourceServer server) {
        this.server = Objects.requireNonNull(server, "server");
    }

    /**
     * Initializes the resource server, fetching facilitator support and validating the routes, unless it has
     * already been initialized.
     *
     * <p>Only errors that cannot heal stop the web application. When a facilitator cannot be reached, the failure
     * is logged and the filter starts; the server then initializes on a later paid request, as
     * {@link HttpResourceServer#processRequest} describes, and answers paid requests with 503 until it succeeds.
     *
     * @param filterConfig the filter configuration, unused
     * @throws ServletException if a route is misconfigured, initialization fails with an unchecked exception, or
     *     the thread is interrupted; the cause holds the underlying failure
     */
    @Override
    public void init(FilterConfig filterConfig) throws ServletException {
        if (server.isInitialized()) {
            return;
        }
        try {
            server.initialize();
        } catch (IOException e) {
            LOG.log(System.Logger.Level.WARNING,
                    "x402 facilitator unavailable at startup; initialization will be retried on a paid request", e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ServletException("x402 initialization was interrupted", e);
        } catch (RuntimeException e) {
            throw new ServletException("x402 initialization failed: " + e.getMessage(), e);
        }
    }

    /**
     * Enforces payment on the request, as described in the class documentation.
     *
     * @throws IOException if the response cannot be written
     * @throws ServletException if the downstream chain fails
     */
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        if (!(req instanceof HttpServletRequest request) || !(res instanceof HttpServletResponse response)) {
            chain.doFilter(req, res);
            return;
        }
        if (request.getAttribute(PAYMENT_PAYLOAD_ATTRIBUTE) != null) {
            // A forward or include inside a request this filter already charged for: do not charge twice.
            chain.doFilter(request, response);
            return;
        }

        ProcessResult result = server.processRequest(new ServletRequestAdapter(request));
        if (result instanceof ProcessResult.PaymentError error) {
            write(response, error.response());
        } else if (result instanceof ProcessResult.PaymentVerified verified) {
            serveVerified(request, response, chain, verified);
        } else {
            chain.doFilter(request, response);
        }
    }

    private void serveVerified(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain chain,
            ProcessResult.PaymentVerified verified) throws IOException, ServletException {
        request.setAttribute(PAYMENT_PAYLOAD_ATTRIBUTE, verified.payload());
        request.setAttribute(PAYMENT_REQUIREMENTS_ATTRIBUTE, verified.requirements());
        HeaderSnapshot upstreamHeaders = HeaderSnapshot.of(response);
        PaidRequest paidRequest = new PaidRequest(request);
        BufferingResponseWrapper buffered = new BufferingResponseWrapper(response, paidRequest);

        boolean handlerCompleted = false;
        try {
            chain.doFilter(paidRequest, buffered);
            handlerCompleted = true;
        } finally {
            if (!handlerCompleted && !response.isCommitted()) {
                upstreamHeaders.resetTo(response);
            }
        }

        if (buffered.getStatus() >= 400) {
            buffered.release();
            return;
        }

        SettlementResult settlement;
        try {
            settlement = server.processSettlement(verified);
        } catch (RuntimeException | Error e) {
            // The handler's headers are already on the real response; keep them from the container's error page.
            if (!response.isCommitted()) {
                upstreamHeaders.resetTo(response);
            }
            throw e;
        }
        if (settlement instanceof SettlementResult.Settled settled) {
            settled.headers().forEach(response::setHeader);
            response.setHeader(CACHE_CONTROL,
                    HttpResourceServer.withPrivateCacheControl(response.getHeader(CACHE_CONTROL)));
            buffered.release();
        } else if (settlement instanceof SettlementResult.Failed failed) {
            upstreamHeaders.resetTo(response);
            write(response, failed.response());
        }
    }

    private static void write(HttpServletResponse response, HttpResponseInstructions instructions)
            throws IOException {
        byte[] body = instructions.bodyBytes();
        response.setStatus(instructions.status());
        instructions.headers().forEach(response::setHeader);
        response.setContentLength(body.length);
        response.getOutputStream().write(body);
    }
}
