package org.x402.spring.web.reactive;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.core.Ordered;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.server.PathContainer;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.cors.reactive.CorsUtils;
import org.springframework.web.reactive.HandlerMapping;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import org.springframework.web.server.WebFilterChain;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.server.CancelOptions;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpRequestContext;
import org.x402.http.HttpResponseInstructions;
import org.x402.http.HttpTransportContext;
import org.x402.http.PaywallConfig;
import org.x402.http.ProcessSettleResult;
import org.x402.http.X402Headers;
import org.x402.http.X402HttpResourceServer;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.web.PaidResponses;
import org.x402.spring.offer.OfferRouteResolver;
import reactor.core.publisher.Mono;

/**
 * The WebFlux adapter: the same contract as the servlet filter. The offer comes from the
 * {@code DispatcherHandler}'s own handler mappings; every core call (which may block on a
 * facilitator) runs on {@code boundedElastic}; the paid handler's response is buffered by a
 * decorator covering {@code writeWith}, {@code writeAndFlushWith} and {@code setComplete}.
 */
public final class X402WebFilter implements WebFilter, Ordered {

  private static final Log LOG = LogFactory.getLog(X402WebFilter.class);
  private static final int RUNNING = 0;
  private static final int DELIVERED = 1;
  private static final int CANCELLED = 2;

  private final X402HttpResourceServer server;
  private final OfferRegistry registry;
  private final OfferRouteResolver routes;
  private final ReactiveHandlerResolver handlers;
  private final PaywallConfig paywallConfig;
  private final boolean paywall;
  private final int order;

  /**
   * Creates the filter.
   *
   * @param server the HTTP resource server
   * @param registry the handler → offer registry
   * @param routes the offer routes
   * @param handlerMappings the dispatcher's handler mappings, read on first use
   * @param paywallConfig paywall options, may be {@code null}
   * @param paywall whether browsers get the HTML paywall
   * @param order the filter order
   */
  public X402WebFilter(X402HttpResourceServer server, OfferRegistry registry,
      OfferRouteResolver routes, Supplier<List<HandlerMapping>> handlerMappings,
      PaywallConfig paywallConfig, boolean paywall, int order) {
    this.server = server;
    this.registry = registry;
    this.routes = routes;
    this.handlers = new ReactiveHandlerResolver(handlerMappings);
    this.paywallConfig = paywallConfig;
    this.paywall = paywall;
    this.order = order;
  }

  @Override
  public int getOrder() {
    return order;
  }

  @Override
  public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
    ServerHttpRequest request = exchange.getRequest();
    if (CorsUtils.isPreFlightRequest(request) || !registry.hasOffers()) {
      return chain.filter(exchange);
    }
    return handlers.resolve(exchange).flatMap(resolution -> {
      String[] paths = paths(request);
      String method = request.getMethod().name();
      String offer = registry.offerFor(resolution.handler());
      String pattern = OfferRegistry.toRoutePattern(resolution.pattern());
      if (offer == null) {
        offer = routes.matchPath(method, paths[0], paths[1]);
        pattern = offer == null ? null : routes.patternOf(offer);
      }
      if (offer == null) {
        return chain.filter(exchange);
      }
      exchange.getAttributes().put(OfferRegistry.DECIDED_OFFER, offer);
      HttpRequestContext context = new HttpRequestContext(
          new ReactiveRequestAdapter(request, paths[0], offer, pattern, paywall), method,
          paths[0], paths[1], null);
      String selected = offer;
      AtomicInteger phase = new AtomicInteger(RUNNING);
      AtomicBoolean released = new AtomicBoolean();
      return BlockingCalls.offload(() -> {
        HttpProcessResult result = server.processHttpRequest(context, paywallConfig);
        if (!phase.compareAndSet(RUNNING, DELIVERED)) {
          // The exchange was cancelled while the call ran: nobody will see this result.
          releaseVerified(result, released);
        }
        return result;
      })
          .doOnCancel(() -> phase.compareAndSet(RUNNING, CANCELLED))
          .doOnDiscard(HttpProcessResult.PaymentVerified.class,
              verified -> releaseVerified(verified, released))
          .map(Optional::of)
          .onErrorResume(FacilitatorResponseException.class, e -> writeJson(exchange.getResponse(),
              502, Map.of("error", String.valueOf(e.getMessage()))).then(Mono.empty()))
          .onErrorResume(RuntimeException.class, e -> {
            LOG.error("x402: payment processing failed for offer \"" + selected + "\"", e);
            return writeJson(exchange.getResponse(), 500, Map.of("error",
                "Internal Server Error")).then(Mono.empty());
          })
          .flatMap(result -> handle(result.get(), exchange, chain, context));
    });
  }

  /**
   * A payment verified for an exchange that no longer exists would never be settled or cancelled;
   * run its cancel hooks (once).
   */
  private static void releaseVerified(HttpProcessResult result, AtomicBoolean released) {
    if (result instanceof HttpProcessResult.PaymentVerified verified
        && released.compareAndSet(false, true)) {
      BlockingCalls.offload(() -> verified.cancellationDispatcher().cancel(
          new CancelOptions(CancellationReason.HANDLER_THREW,
              new IllegalStateException("request cancelled before completion"), null)))
          .subscribe(r -> { }, e -> LOG.warn("x402: cancel after a dropped request failed", e));
    }
  }

  /** Raw path within the application ({@code ;} parameters stripped) and its decoded form. */
  static String[] paths(ServerHttpRequest request) {
    StringBuilder raw = new StringBuilder();
    StringBuilder decoded = new StringBuilder();
    for (PathContainer.Element element : request.getPath().pathWithinApplication().elements()) {
      if (element instanceof PathContainer.PathSegment segment) {
        String value = segment.value();
        int semicolon = value.indexOf(';');
        raw.append(semicolon < 0 ? value : value.substring(0, semicolon));
        decoded.append(segment.valueToMatch());
      } else {
        raw.append(element.value());
        decoded.append(element.value());
      }
    }
    String rawPath = raw.length() == 0 ? "/" : raw.toString();
    String decodedPath = decoded.length() == 0 ? "/" : decoded.toString();
    return new String[] {rawPath, decodedPath};
  }

  private Mono<Void> handle(HttpProcessResult result, ServerWebExchange exchange,
      WebFilterChain chain, HttpRequestContext context) {
    if (result instanceof HttpProcessResult.NoPaymentRequired) {
      return chain.filter(exchange);
    }
    if (result instanceof HttpProcessResult.PaymentError error) {
      return write(exchange.getResponse(), error.response());
    }
    if (result instanceof HttpProcessResult.RouteUnavailable unavailable) {
      if (unavailable.retryable()) {
        exchange.getResponse().getHeaders().set("Retry-After", "5");
        return writeJson(exchange.getResponse(), 503,
            Map.of("error", "x402 facilitator unavailable"));
      }
      return writeJson(exchange.getResponse(), 500, Map.of("error", "x402 route configuration"));
    }
    HttpProcessResult.PaymentVerified verified = (HttpProcessResult.PaymentVerified) result;
    PaidExchange paid = new PaidExchange(verified, context,
        new BufferingResponse(exchange.getResponse()));
    return chain.filter(exchange.mutate().response(paid.buffered).build())
        .then(Mono.defer(() -> complete(paid)))
        .onErrorResume(e -> paid.finish() ? handlerThrew(paid, e).then(Mono.error(e))
            : Mono.error(e))
        .doOnCancel(() -> {
          if (paid.finish()) {
            BlockingCalls.offload(() -> paid.verified.cancellationDispatcher().cancel(
                new CancelOptions(CancellationReason.HANDLER_THREW,
                    new IllegalStateException("request cancelled before completion"), null)))
                .subscribe(r -> { }, e -> LOG.warn("x402: cancel after a dropped request "
                    + "failed", e));
          }
        });
  }

  private Mono<Void> handlerThrew(PaidExchange paid, Throwable error) {
    ServerHttpResponse real = paid.buffered.getDelegate();
    return BlockingCalls.offload(() -> Optional.ofNullable(PaidResponses.cancel(server, paid.verified,
        CancellationReason.HANDLER_THREW, error, null, real.getHeaders().getCacheControl())))
        .doOnNext(headers -> {
      if (!real.isCommitted()) {
        headers.ifPresent(h -> h.forEach(real.getHeaders()::set));
      }
    }).then();
  }

  private Mono<Void> complete(PaidExchange paid) {
    if (!paid.finish()) {
      return Mono.empty();
    }
    ServerHttpResponse real = paid.buffered.getDelegate();
    HttpHeaders handlerHeaders = paid.buffered.getHeaders();
    HttpStatusCode status = paid.buffered.getStatusCode();
    int code = status == null ? 200 : status.value();
    String overrides = handlerHeaders.getFirst(X402Headers.SETTLEMENT_OVERRIDES);
    handlerHeaders.remove(X402Headers.SETTLEMENT_OVERRIDES);
    if (code >= 400) {
      return BlockingCalls.offload(() -> Optional.ofNullable(PaidResponses.cancel(server, paid.verified,
          CancellationReason.HANDLER_FAILED, null, code, handlerHeaders.getCacheControl())))
          .flatMap(headers -> {
        headers.ifPresent(h -> h.forEach(handlerHeaders::set));
        return release(paid);
      });
    }
    Map<String, String> responseHeaders = new LinkedHashMap<>(handlerHeaders.toSingleValueMap());
    if (overrides != null) {
      responseHeaders.put(X402Headers.SETTLEMENT_OVERRIDES, overrides);
    }
    byte[] body = paid.buffered.bytes();
    return BlockingCalls.offload(() -> server.processSettlement(paid.verified,
            new HttpTransportContext(paid.context, body, responseHeaders)))
        .flatMap(result -> {
          if (result instanceof ProcessSettleResult.Failure failure) {
            return write(real, failure.httpResponse());
          }
          result.headers().forEach(handlerHeaders::set);
          handlerHeaders.setCacheControl(
              X402HttpResourceServer.withPrivateCacheControl(handlerHeaders.getCacheControl()));
          return release(paid);
        })
        .onErrorResume(FacilitatorResponseException.class, e -> writeJson(real, 502,
            Map.of("error", String.valueOf(e.getMessage()))));
  }

  private static Mono<Void> release(PaidExchange paid) {
    ServerHttpResponse real = paid.buffered.getDelegate();
    paid.buffered.applyToDelegate();
    byte[] bytes = paid.buffered.bytes();
    if (bytes.length == 0 && !paid.buffered.wroteBody()) {
      return real.setComplete();
    }
    real.getHeaders().setContentLength(bytes.length);
    return real.writeWith(Mono.fromSupplier(() -> real.bufferFactory().wrap(bytes)));
  }

  static Mono<Void> write(ServerHttpResponse response, HttpResponseInstructions instructions) {
    response.setStatusCode(HttpStatusCode.valueOf(instructions.status()));
    instructions.headers().forEach(response.getHeaders()::set);
    byte[] bytes = PaidResponses.body(instructions);
    response.getHeaders().setContentLength(bytes.length);
    return response.writeWith(Mono.fromSupplier(() -> response.bufferFactory().wrap(bytes)));
  }

  static Mono<Void> writeJson(ServerHttpResponse response, int status, Map<String, ?> body) {
    byte[] bytes = PaidResponses.json(body);
    response.setStatusCode(HttpStatusCode.valueOf(status));
    response.getHeaders().setContentType(MediaType.APPLICATION_JSON);
    response.getHeaders().setContentLength(bytes.length);
    return response.writeWith(Mono.fromSupplier(() -> response.bufferFactory().wrap(bytes)));
  }

  /** One paid exchange. */
  private static final class PaidExchange {
    final HttpProcessResult.PaymentVerified verified;
    final HttpRequestContext context;
    final BufferingResponse buffered;
    final AtomicBoolean finished = new AtomicBoolean();

    PaidExchange(HttpProcessResult.PaymentVerified verified, HttpRequestContext context,
        BufferingResponse buffered) {
      this.verified = verified;
      this.context = context;
      this.buffered = buffered;
    }

    boolean finish() {
      return finished.compareAndSet(false, true);
    }
  }
}
