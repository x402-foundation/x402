package org.x402.http;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The default {@link RouteResolver}: route patterns in declaration order, matched against every
 * form of the request path ({@link RouteViews}); forms that select no route are ignored, and forms
 * that select different routes make the request ambiguous ({@link AmbiguousRouteException}). In
 * each form the first route whose verb matches wins: a route without a verb matches every method
 * except {@code OPTIONS} (a CORS preflight carries no payment), and {@code HEAD} falls back to
 * {@code GET} routes, as in the TypeScript SDK (#3738).
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

  /**
   * {@inheritDoc}
   *
   * @throws AmbiguousRouteException when the forms of the path select different routes
   */
  @Override
  public RouteMatch resolve(HttpRequestContext context) {
    String method = (context.method() != null ? context.method()
        : context.adapter().getMethod()).toUpperCase(Locale.ROOT);
    List<Compiled> found = RouteViews.select(
        RouteViews.forms(context.path(), context.decodedPath()), null,
        paths -> find(method, paths.get(0)));
    if (found.isEmpty()) {
      return null;
    }
    if (found.size() > 1) {
      throw new AmbiguousRouteException(found.stream().map(Compiled::key).toList());
    }
    Compiled c = found.get(0);
    return new RouteMatch(c.key(), c.pattern().path(), c.config());
  }

  private Compiled find(String method, String normalized) {
    for (Compiled c : compiled) {
      if (verbMatches(c.pattern().verb(), method) && c.pattern().matchesNormalized(normalized)) {
        return c;
      }
    }
    if ("HEAD".equals(method)) {
      for (Compiled c : compiled) {
        if ("GET".equals(c.pattern().verb()) && c.pattern().matchesNormalized(normalized)) {
          return c;
        }
      }
    }
    return null;
  }

  private static boolean verbMatches(String verb, String method) {
    return verb.equals(method) || ("*".equals(verb) && !"OPTIONS".equals(method));
  }

  @Override
  public Map<String, RouteConfig> routes() {
    return routes;
  }
}
