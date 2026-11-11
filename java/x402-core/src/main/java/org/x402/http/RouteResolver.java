package org.x402.http;

import java.util.Map;

/**
 * Finds the route of a request. The default {@link PatternRouteResolver} matches route patterns;
 * the Spring starter resolves through Spring's own handler mapping.
 */
public interface RouteResolver {

  /**
   * Resolves a request.
   *
   * @param context the request
   * @return the route, or {@code null} when no payment is required
   */
  RouteMatch resolve(HttpRequestContext context);

  /**
   * Every route, keyed as in {@link RouteMatch#key()}, in declaration order; validated at
   * initialize.
   *
   * @return the routes
   */
  Map<String, RouteConfig> routes();
}
