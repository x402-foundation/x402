package org.x402.spring;

import org.x402.http.RouteConfig;

/**
 * Adjusts a resolved offer before core sees it (e.g. extension declarations or custom 402
 * bodies). Runs after YAML resolution and option contributors.
 */
@FunctionalInterface
public interface X402RouteCustomizer {

  /**
   * Returns the route to use for an offer.
   *
   * @param offer the offer name
   * @param route the resolved route
   * @return the route, possibly replaced
   */
  RouteConfig customize(String offer, RouteConfig route);
}
