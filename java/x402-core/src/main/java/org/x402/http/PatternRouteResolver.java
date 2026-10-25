package org.x402.http;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The default {@link RouteResolver}: route patterns in declaration order. The raw path is
 * normalized and matched first; when it fails and a different decoded path is known, the decoded
 * path is tried.
 */
public final class PatternRouteResolver implements RouteResolver {

  private record Compiled(String key, RoutePattern pattern, RouteConfig config) {}

  private final Map<String, RouteConfig> routes;
  private final List<Compiled> compiled = new ArrayList<>();

  /**
   * Creates a resolver over pattern-keyed routes.
   *
   * @param routes pattern → route, in precedence order
   */
  public PatternRouteResolver(Map<String, RouteConfig> routes) {
    this.routes = Collections.unmodifiableMap(new LinkedHashMap<>(routes));
    this.routes.forEach((key, config) ->
        compiled.add(new Compiled(key, RoutePattern.parse(key), config)));
  }

  /**
   * One route for every request.
   *
   * @param config the route
   * @return the resolver, keyed {@code *}
   */
  public static PatternRouteResolver single(RouteConfig config) {
    return new PatternRouteResolver(Map.of("*", config));
  }

  @Override
  public RouteMatch resolve(HttpRequestContext context) {
    String method = context.method() != null ? context.method() : context.adapter().getMethod();
    RouteMatch match = find(method, RoutePattern.normalizePath(context.path()));
    if (match != null) {
      return match;
    }
    String decoded = context.decodedPath();
    if (decoded != null && !decoded.equals(context.path())) {
      return find(method, RoutePattern.normalizeDecodedPath(decoded));
    }
    return null;
  }

  private RouteMatch find(String method, String normalized) {
    for (Compiled c : compiled) {
      if (c.pattern().matches(method, normalized)) {
        return new RouteMatch(c.key(), c.pattern().path(), c.config());
      }
    }
    return null;
  }

  @Override
  public Map<String, RouteConfig> routes() {
    return routes;
  }
}
