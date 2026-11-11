package org.x402.spring.offer;

/**
 * Implemented by the stack adapters: the offer chosen for a request by Spring's handler lookup
 * (annotation first, then {@code path:} routes). {@link OfferRouteResolver} answers from it, so the
 * core and the adapter never disagree about the route.
 */
public interface OfferSelection {

  /**
   * The selected offer.
   *
   * @return the offer name, or {@code null} when the request is free
   */
  String selectedOffer();

  /**
   * The pattern the request matched, passed to hooks as {@code routePattern}.
   *
   * @return the pattern, may be {@code null}
   */
  String selectedPattern();
}
