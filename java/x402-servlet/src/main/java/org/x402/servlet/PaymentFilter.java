package org.x402.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collection;
import java.util.Map;
import java.util.Objects;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpRequestContext;
import org.x402.http.HttpResponseInstructions;
import org.x402.http.HttpTransportContext;
import org.x402.http.PaywallConfig;
import org.x402.http.ProcessSettleResult;
import org.x402.http.X402HttpResourceServer;

/**
 * Charges for the routes of an {@link X402HttpResourceServer} in any Jakarta Servlet container,
 * without Spring. Adapted from #4129 (Stefano Amorelli) onto this SDK's HTTP layer; the wire
 * behaviour is the Spring starter's.
 *
 * <ul>
 *   <li>A request no route selects, a CORS preflight, and a request inside one this filter already
 *       charged (a forward) pass through. Every form of the path is matched; forms that select
 *       different routes are answered 400 {@code {"error":"invalid_path"}}.
 *   <li>An unpaid or invalid payment gets the 402 (the paywall page for browsers); a route whose
 *       facilitator is not reachable yet answers 503 with {@code Retry-After}.
 *   <li>A verified request runs the chain with its whole response held back. A handler status of
 *       400 or more, or an exception, cancels the payment (nothing is settled); otherwise the
 *       payment settles and the response is released with {@code PAYMENT-RESPONSE} and
 *       {@code private} merged into {@code Cache-Control}. A failed settle discards the handler's
 *       response and answers 402; a facilitator transport failure answers 502.
 *   <li>Paid routes must be synchronous: the handler's request refuses {@code startAsync} and
 *       protocol upgrades, which would bypass the buffer. The response body is held in memory.
 * </ul>
 *
 * <p>Map the filter for {@code REQUEST} and {@code FORWARD} dispatches: routes are matched
 * against the dispatched path, so without {@code FORWARD} a free URL that forwards to a paid path
 * would serve it unpaid. Mark it async-supported, or every route it covers becomes synchronous
 * (paid routes refuse async themselves). {@code init} syncs the resource server unless the
 * application already did; when only facilitators are missing, it starts anyway and re-syncs in
 * the background.
 *
 * <pre>{@code
 * FilterRegistration.Dynamic x402 = servletContext.addFilter("x402", new PaymentFilter(http));
 * x402.setAsyncSupported(true);
 * x402.addMappingForUrlPatterns(
 *     EnumSet.of(DispatcherType.REQUEST, DispatcherType.FORWARD), false, "/*");
 * }</pre>
 *
 * <p>Instances are thread-safe.
 */
public final class PaymentFilter implements Filter {

  /** Request attribute holding the verified payment of a request this filter charges. */
  public static final String PAYMENT_ATTRIBUTE = PaymentFilter.class.getName() + ".PAYMENT";

  private static final System.Logger LOG = System.getLogger(PaymentFilter.class.getName());
  private static final String CACHE_CONTROL = "Cache-Control";

  private final X402HttpResourceServer server;
  private final PaywallConfig paywallConfig;
  private final boolean paywall;
  private final ResourceServerSync sync;

  /**
   * Creates the filter with the paywall page for browsers and default paywall options.
   *
   * @param server the HTTP resource server
   */
  public PaymentFilter(X402HttpResourceServer server) {
    this(server, null, true);
  }

  /**
   * Creates the filter.
   *
   * @param server the HTTP resource server
   * @param paywallConfig paywall options, may be {@code null}
   * @param paywall whether browsers get the HTML paywall ({@code false}: always JSON)
   */
  public PaymentFilter(X402HttpResourceServer server, PaywallConfig paywallConfig,
      boolean paywall) {
    this(server, paywallConfig, paywall, ResourceServerSync.Settings.defaults());
  }

  PaymentFilter(X402HttpResourceServer server, PaywallConfig paywallConfig, boolean paywall,
      ResourceServerSync.Settings settings) {
    this.server = Objects.requireNonNull(server, "server");
    this.paywallConfig = paywallConfig;
    this.paywall = paywall;
    this.sync = new ResourceServerSync(server, settings);
  }

  /**
   * Syncs the resource server unless the application already did.
   *
   * @param filterConfig unused
   * @throws ServletException when a route is invalid for a reason a re-sync cannot heal
   */
  @Override
  public void init(FilterConfig filterConfig) throws ServletException {
    try {
      sync.start();
    } catch (RuntimeException e) {
      throw new ServletException("x402 initialization failed: " + e.getMessage(), e);
    }
  }

  /** Stops the background re-sync. */
  @Override
  public void destroy() {
    sync.stop();
  }

  @Override
  public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
      throws IOException, ServletException {
    if (!(req instanceof HttpServletRequest request)
        || !(res instanceof HttpServletResponse response)
        || request.getAttribute(PAYMENT_ATTRIBUTE) != null
        || request.getDispatcherType() == DispatcherType.INCLUDE
        || isPreflight(request)) {
      chain.doFilter(req, res);
      return;
    }
    String rawPath = ServletRequestAdapter.rawPath(request);
    HttpRequestContext context = new HttpRequestContext(
        new ServletRequestAdapter(request, rawPath, paywall), request.getMethod(), rawPath,
        ServletRequestAdapter.decodedPath(request), null);
    HttpProcessResult result;
    try {
      result = server.processHttpRequest(context, paywallConfig);
    } catch (FacilitatorResponseException e) {
      writeJson(response, 502, Map.of("error", String.valueOf(e.getMessage())));
      return;
    } catch (RuntimeException e) {
      LOG.log(System.Logger.Level.ERROR, "x402: payment processing failed", e);
      writeJson(response, 500, Map.of("error", "Internal Server Error"));
      return;
    }
    if (result instanceof HttpProcessResult.NoPaymentRequired) {
      chain.doFilter(request, response);
    } else if (result instanceof HttpProcessResult.PaymentError error) {
      write(response, error.response());
    } else if (result instanceof HttpProcessResult.RouteUnavailable unavailable) {
      routeUnavailable(response, unavailable);
    } else {
      serve((HttpProcessResult.PaymentVerified) result, context, request, response, chain);
    }
  }

  private void serve(HttpProcessResult.PaymentVerified verified, HttpRequestContext context,
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws IOException, ServletException {
    request.setAttribute(PAYMENT_ATTRIBUTE, verified);
    PaidRequest paidRequest = new PaidRequest(request);
    BufferingResponseWrapper wrapper = new BufferingResponseWrapper(response, paidRequest);
    try {
      chain.doFilter(paidRequest, wrapper);
    } catch (IOException | ServletException | RuntimeException e) {
      Map<String, String> headers = PaidResponses.cancel(server, verified,
          CancellationReason.HANDLER_THREW, e, null, response.getHeader(CACHE_CONTROL));
      if (headers != null && !response.isCommitted()) {
        headers.forEach(response::setHeader);
      }
      throw e;
    }
    int status = wrapper.getStatus();
    if (status >= 400) {
      Map<String, String> headers = PaidResponses.cancel(server, verified,
          CancellationReason.HANDLER_FAILED, null, status, cacheControl(wrapper));
      if (headers != null) {
        headers.forEach(wrapper::setHeader);
      }
      wrapper.release();
      return;
    }
    ProcessSettleResult result;
    try {
      result = server.processSettlement(verified,
          new HttpTransportContext(context, wrapper.body(), wrapper.headersForSettlement()));
    } catch (FacilitatorResponseException e) {
      writeJson(response, 502, Map.of("error", String.valueOf(e.getMessage())));
      return;
    }
    if (result instanceof ProcessSettleResult.Failure failure) {
      write(response, failure.httpResponse());
      return;
    }
    result.headers().forEach(wrapper::setHeader);
    wrapper.setHeader(CACHE_CONTROL,
        X402HttpResourceServer.withPrivateCacheControl(cacheControl(wrapper)));
    wrapper.release();
  }

  private static boolean isPreflight(HttpServletRequest request) {
    return "OPTIONS".equalsIgnoreCase(request.getMethod())
        && request.getHeader("Origin") != null
        && request.getHeader("Access-Control-Request-Method") != null;
  }

  private static void routeUnavailable(HttpServletResponse response,
      HttpProcessResult.RouteUnavailable unavailable) throws IOException {
    if (unavailable.retryable()) {
      response.setHeader("Retry-After", "5");
      writeJson(response, 503, Map.of("error", "x402 facilitator unavailable"));
    } else {
      writeJson(response, 500, Map.of("error", "x402 route configuration"));
    }
  }

  /** Every Cache-Control value the client would get, outer and handler's, as one value. */
  private static String cacheControl(BufferingResponseWrapper wrapper) {
    Collection<String> values = wrapper.getHeaders(CACHE_CONTROL);
    return values.isEmpty() ? null : String.join(", ", values);
  }

  private static void write(HttpServletResponse response, HttpResponseInstructions instructions)
      throws IOException {
    response.setStatus(instructions.status());
    instructions.headers().forEach(response::setHeader);
    byte[] bytes = PaidResponses.body(instructions);
    response.setContentLength(bytes.length);
    response.getOutputStream().write(bytes);
    response.flushBuffer();
  }

  private static void writeJson(HttpServletResponse response, int status, Map<String, ?> body)
      throws IOException {
    byte[] bytes = PaidResponses.json(body);
    response.setStatus(status);
    response.setContentType("application/json");
    response.setContentLength(bytes.length);
    response.getOutputStream().write(bytes);
    response.flushBuffer();
  }
}
