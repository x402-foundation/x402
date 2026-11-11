package org.x402.http;

import java.util.Objects;

/**
 * A resolved route.
 *
 * @param key the route's key in {@link RouteResolver#routes()} (a pattern, or an offer name)
 * @param pattern the route's path pattern, passed to hooks as {@code routePattern}
 * @param config the route
 */
public record RouteMatch(String key, String pattern, RouteConfig config) {

  /** Validates. */
  public RouteMatch {
    Objects.requireNonNull(key, "key");
    Objects.requireNonNull(config, "config");
  }
}
