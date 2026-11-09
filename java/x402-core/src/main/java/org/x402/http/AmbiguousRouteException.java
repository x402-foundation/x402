package org.x402.http;

import java.util.List;

/**
 * The forms of a request path select different routes, so which one the framework serves depends
 * on how it dispatches (see {@link RouteViews}). {@link X402HttpResourceServer} answers such a
 * request with 400 {@code {"error":"invalid_path"}} and neither serves nor charges it; adapters
 * that match routes themselves do the same. The route keys are for logs and never sent to the
 * client. Java-only: the TypeScript SDK serves the route of the first form that matches.
 */
public class AmbiguousRouteException extends RuntimeException {

  private static final long serialVersionUID = 1L;

  private final transient List<String> routeKeys;

  /**
   * Creates the exception.
   *
   * @param routeKeys the keys of the routes the forms selected, in the order found
   */
  public AmbiguousRouteException(List<String> routeKeys) {
    super("x402: the forms of the request path select different routes " + routeKeys
        + "; answering 400 invalid_path");
    this.routeKeys = List.copyOf(routeKeys);
  }

  /**
   * The keys of the routes the forms selected.
   *
   * @return the route keys, in the order found
   */
  public List<String> routeKeys() {
    return routeKeys;
  }
}
