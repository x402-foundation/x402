package org.x402.spring.web.servlet;

import jakarta.servlet.AsyncEvent;
import jakarta.servlet.AsyncListener;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.web.cors.CorsUtils;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.util.UrlPathHelper;
import org.springframework.web.util.WebUtils;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.server.CancelOptions;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpRequestContext;
import org.x402.http.HttpResponseInstructions;
import org.x402.http.HttpTransportContext;
import org.x402.http.PaywallConfig;
import org.x402.http.ProcessSettleResult;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.web.PaidResponses;
import org.x402.spring.offer.OfferRouteResolver;

/**
 * The WebMvc adapter: selects the offer through Spring's own handler lookup, runs the
 * adapter contract documented on {@link X402HttpResourceServer}, buffers the paid handler's
 * response and settles exactly once, on the final dispatch (async requests included).
 */
public final class X402ServletFilter extends OncePerRequestFilter {

  /** Request attribute holding the paid request's state across async dispatches. */
  public static final String STATE_ATTRIBUTE = X402ServletFilter.class.getName() + ".STATE";

  private static final Log LOG = LogFactory.getLog(X402ServletFilter.class);
  private static final UrlPathHelper RAW_PATHS = rawPathHelper();

  private final Supplier<X402HttpResourceServer> server;
  private final Supplier<OfferRegistry> registry;
  private final Supplier<OfferRouteResolver> routes;
  private final ServletHandlerResolver handlers;
  private final PaywallConfig paywallConfig;
  private final boolean paywall;

  /**
   * Creates the filter. Dependencies are suppliers so the filter can be registered before the
   * web infrastructure exists.
   *
   * @param server the HTTP resource server
   * @param registry the handler → offer registry
   * @param routes the offer routes
   * @param handlerMappings the dispatcher's handler mappings, in order
   * @param paywallConfig paywall options, may be {@code null}
   * @param paywall whether browsers get the HTML paywall
   */
  public X402ServletFilter(Supplier<X402HttpResourceServer> server,
      Supplier<OfferRegistry> registry, Supplier<OfferRouteResolver> routes,
      Supplier<List<HandlerMapping>> handlerMappings, PaywallConfig paywallConfig,
      boolean paywall) {
    this.server = server;
    this.registry = registry;
    this.routes = routes;
    this.handlers = new ServletHandlerResolver(handlerMappings);
    this.paywallConfig = paywallConfig;
    this.paywall = paywall;
  }

  private static UrlPathHelper rawPathHelper() {
    UrlPathHelper helper = new UrlPathHelper();
    helper.setUrlDecode(false);
    helper.setRemoveSemicolonContent(true);
    return helper;
  }

  @Override
  protected boolean shouldNotFilterAsyncDispatch() {
    return false;
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    Object existing = request.getAttribute(STATE_ATTRIBUTE);
    if (isAsyncDispatch(request)) {
      if (existing instanceof PaidRequest paid) {
        BufferingResponse wrapper =
            WebUtils.getNativeResponse(response, BufferingResponse.class);
        runHandler(paid, request, wrapper != null ? response : paid.wrapper, chain);
      } else {
        chain.doFilter(request, response);
      }
      return;
    }
    if (existing != null || CorsUtils.isPreFlightRequest(request) || !registry.get().hasOffers()) {
      chain.doFilter(request, response);
      return;
    }
    String rawPath = RAW_PATHS.getPathWithinApplication(request);
    String decodedPath = UrlPathHelper.defaultInstance.getPathWithinApplication(request);
    ServletHandlerResolver.Resolution resolution = handlers.resolve(request);
    String offer = registry.get().offerFor(resolution.handler());
    String pattern = OfferRegistry.toRoutePattern(resolution.pattern());
    if (offer == null) {
      offer = routes.get().matchPath(request.getMethod(), rawPath, decodedPath);
      pattern = offer == null ? null : routes.get().patternOf(offer);
    }
    if (offer == null) {
      chain.doFilter(request, response);
      return;
    }
    request.setAttribute(OfferRegistry.DECIDED_OFFER, offer);
    ServletRequestAdapter adapter =
        new ServletRequestAdapter(request, rawPath, offer, pattern, paywall);
    HttpRequestContext context = new HttpRequestContext(adapter, request.getMethod(), rawPath,
        decodedPath, null);
    HttpProcessResult result;
    try {
      result = server.get().processHttpRequest(context, paywallConfig);
    } catch (FacilitatorResponseException e) {
      writeJson(response, 502, Map.of("error", String.valueOf(e.getMessage())));
      return;
    } catch (RuntimeException e) {
      LOG.error("x402: payment processing failed for offer \"" + offer + "\"", e);
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
      HttpProcessResult.PaymentVerified verified = (HttpProcessResult.PaymentVerified) result;
      PaidRequest paid = new PaidRequest(verified, context, new BufferingResponse(response));
      request.setAttribute(STATE_ATTRIBUTE, paid);
      runHandler(paid, request, paid.wrapper, chain);
    }
  }

  static void routeUnavailable(HttpServletResponse response,
      HttpProcessResult.RouteUnavailable unavailable) throws IOException {
    if (unavailable.retryable()) {
      response.setHeader("Retry-After", "5");
      writeJson(response, 503, Map.of("error", "x402 facilitator unavailable"));
    } else {
      writeJson(response, 500, Map.of("error", "x402 route configuration"));
    }
  }

  private void runHandler(PaidRequest paid, HttpServletRequest request, ServletResponse response,
      FilterChain chain) throws ServletException, IOException {
    try {
      chain.doFilter(request, response);
    } catch (IOException | ServletException | RuntimeException e) {
      if (paid.finish()) {
        handlerThrew(paid, e);
      }
      throw e;
    }
    if (request.isAsyncStarted()) {
      if (paid.listening.compareAndSet(false, true)) {
        request.getAsyncContext().addListener(new Abandoned(paid));
      }
      return;
    }
    if (paid.finish()) {
      complete(paid);
    }
  }

  private void handlerThrew(PaidRequest paid, Throwable error) {
    HttpServletResponse real = (HttpServletResponse) paid.wrapper.getResponse();
    Map<String, String> headers = PaidResponses.cancel(server.get(), paid.verified,
        CancellationReason.HANDLER_THREW, error, null, real.getHeader("Cache-Control"));
    if (headers != null && !real.isCommitted()) {
      headers.forEach(real::setHeader);
    }
  }

  private void complete(PaidRequest paid) throws IOException {
    BufferingResponse wrapper = paid.wrapper;
    HttpServletResponse real = (HttpServletResponse) wrapper.getResponse();
    X402HttpResourceServer http = server.get();
    int status = wrapper.getStatus();
    if (status >= 400) {
      Map<String, String> headers = PaidResponses.cancel(http, paid.verified,
          CancellationReason.HANDLER_FAILED, null, status, wrapper.getHeader("Cache-Control"));
      if (headers != null) {
        headers.forEach(wrapper::setHeader);
      }
      wrapper.release();
      return;
    }
    ProcessSettleResult result;
    try {
      result = http.processSettlement(paid.verified, new HttpTransportContext(paid.context,
          wrapper.body(), wrapper.headersForSettlement()));
    } catch (FacilitatorResponseException e) {
      writeJson(real, 502, Map.of("error", String.valueOf(e.getMessage())));
      return;
    }
    if (result instanceof ProcessSettleResult.Failure failure) {
      write(real, failure.httpResponse());
      return;
    }
    result.headers().forEach(wrapper::setHeader);
    wrapper.setHeader("Cache-Control",
        X402HttpResourceServer.withPrivateCacheControl(wrapper.getHeader("Cache-Control")));
    wrapper.release();
  }

  static void write(HttpServletResponse response, HttpResponseInstructions instructions)
      throws IOException {
    response.setStatus(instructions.status());
    instructions.headers().forEach(response::setHeader);
    byte[] bytes = PaidResponses.body(instructions);
    response.setContentLength(bytes.length);
    response.getOutputStream().write(bytes);
    response.flushBuffer();
  }

  static void writeJson(HttpServletResponse response, int status, Map<String, ?> body)
      throws IOException {
    byte[] bytes = PaidResponses.json(body);
    response.setStatus(status);
    response.setContentType("application/json");
    response.setContentLength(bytes.length);
    response.getOutputStream().write(bytes);
    response.flushBuffer();
  }

  /** The state of one paid request, kept across async dispatches. */
  static final class PaidRequest {
    final HttpProcessResult.PaymentVerified verified;
    final HttpRequestContext context;
    final BufferingResponse wrapper;
    final AtomicBoolean finished = new AtomicBoolean();
    final AtomicBoolean listening = new AtomicBoolean();

    PaidRequest(HttpProcessResult.PaymentVerified verified, HttpRequestContext context,
        BufferingResponse wrapper) {
      this.verified = verified;
      this.context = context;
      this.wrapper = wrapper;
    }

    boolean finish() {
      return finished.compareAndSet(false, true);
    }
  }

  /** Cancels a paid async request that ends without a final dispatch (e.g. a dropped client). */
  private static final class Abandoned implements AsyncListener {
    private final PaidRequest paid;

    Abandoned(PaidRequest paid) {
      this.paid = paid;
    }

    @Override
    public void onComplete(AsyncEvent event) {
      if (paid.finish()) {
        paid.verified.cancellationDispatcher().cancel(new CancelOptions(
            CancellationReason.HANDLER_THREW,
            new IllegalStateException("async request ended without a final dispatch"), null));
      }
    }

    @Override
    public void onTimeout(AsyncEvent event) {
      // Spring dispatches timeouts; onComplete covers the rest.
    }

    @Override
    public void onError(AsyncEvent event) {
      // onComplete follows.
    }

    @Override
    public void onStartAsync(AsyncEvent event) {
      // re-registered by the container
    }
  }
}
