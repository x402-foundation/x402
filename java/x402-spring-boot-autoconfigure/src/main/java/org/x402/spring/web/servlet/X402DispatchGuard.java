package org.x402.spring.web.servlet;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import java.util.function.Supplier;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.x402.spring.offer.OfferRegistry;

/**
 * Fails closed when Spring dispatches to a paid handler the x402 filter did not decide for: a
 * forward or include, a URL-rewriting filter running after x402, or any other mismatch between the
 * filter's handler lookup and the actual dispatch. The handler is not run; the response is a 500
 * and the cause is logged.
 */
public final class X402DispatchGuard implements HandlerInterceptor {

  private static final Log LOG = LogFactory.getLog(X402DispatchGuard.class);

  private final Supplier<OfferRegistry> registry;

  /**
   * Creates the guard.
   *
   * @param registry the handler → offer registry
   */
  public X402DispatchGuard(Supplier<OfferRegistry> registry) {
    this.registry = registry;
  }

  @Override
  public boolean preHandle(HttpServletRequest request, HttpServletResponse response,
      Object handler) throws IOException {
    if (!(handler instanceof HandlerMethod)) {
      return true;
    }
    String offer = registry.get().offerFor(handler);
    if (offer == null || offer.equals(request.getAttribute(OfferRegistry.DECIDED_OFFER))) {
      return true;
    }
    LOG.error("x402: refused to run " + ((HandlerMethod) handler).getShortLogMessage()
        + " (offer \"" + offer + "\"): the x402 filter did not process this request for that "
        + "offer (dispatch " + request.getDispatcherType()
        + (request.getDispatcherType() == DispatcherType.REQUEST
            ? ", the request was rewritten after the x402 filter" : "")
        + ")");
    X402ServletFilter.writeJson(response, 500, Map.of("error", "Internal Server Error"));
    return false;
  }
}
