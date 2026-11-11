package org.x402.spring.web.reactive;

import java.util.function.Supplier;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.core.Ordered;
import org.springframework.http.HttpStatus;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.reactive.HandlerAdapter;
import org.springframework.web.reactive.HandlerResult;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ServerWebExchange;
import org.x402.spring.offer.OfferRegistry;
import reactor.core.publisher.Mono;

/**
 * The WebFlux dispatch guard: handles every handler method that belongs to an
 * offer, ahead of the request-mapping adapter. When the x402 web filter did not decide that offer
 * for this exchange (e.g. a path rewrite after the filter), the handler is not run and the
 * exchange fails with 500; otherwise the request-mapping adapter runs it as usual.
 */
public final class X402DispatchGuardHandlerAdapter implements HandlerAdapter, Ordered {

  private static final Log LOG = LogFactory.getLog(X402DispatchGuardHandlerAdapter.class);

  private final OfferRegistry registry;
  private final Supplier<HandlerAdapter> delegate;

  /**
   * Creates the guard.
   *
   * @param registry the handler → offer registry
   * @param delegate the request-mapping handler adapter, resolved on first use
   */
  public X402DispatchGuardHandlerAdapter(OfferRegistry registry,
      Supplier<HandlerAdapter> delegate) {
    this.registry = registry;
    this.delegate = delegate;
  }

  @Override
  public int getOrder() {
    return Ordered.HIGHEST_PRECEDENCE;
  }

  @Override
  public boolean supports(Object handler) {
    return handler instanceof HandlerMethod && registry.offerFor(handler) != null;
  }

  @Override
  public Mono<HandlerResult> handle(ServerWebExchange exchange, Object handler) {
    String offer = registry.offerFor(handler);
    if (!offer.equals(exchange.getAttribute(OfferRegistry.DECIDED_OFFER))) {
      LOG.error("x402: refused to run " + ((HandlerMethod) handler).getShortLogMessage()
          + " (offer \"" + offer + "\"): the x402 web filter did not process this exchange for "
          + "that offer (rewritten after the filter?)");
      return Mono.error(new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
          "x402: paid handler reached without payment processing"));
    }
    return delegate.get().handle(exchange, handler);
  }
}
