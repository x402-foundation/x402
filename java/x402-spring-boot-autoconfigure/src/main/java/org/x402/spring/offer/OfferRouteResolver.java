package org.x402.spring.offer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.http.AmbiguousRouteException;
import org.x402.http.HttpRequestContext;
import org.x402.http.RouteConfig;
import org.x402.http.RouteMatch;
import org.x402.http.RoutePattern;
import org.x402.http.RouteResolver;
import org.x402.http.RouteViews;

/**
 * Routes keyed by offer name. A request whose adapter carries an {@link OfferSelection} resolves to
 * that offer; otherwise the {@code path:} offers are matched as x402 route patterns against every
 * form of the path ({@link #matchPath(String, String, String, String, String)}); forms that
 * select different offers make the request ambiguous ({@link AmbiguousRouteException}, 400).
 */
public final class OfferRouteResolver implements RouteResolver {

  private record PathOffer(String name, RoutePattern pattern) {}

  private final Map<String, RouteConfig> routes;
  private final List<PathOffer> pathOffers = new ArrayList<>();

  /**
   * Creates the resolver.
   *
   * @param offers the resolved offers
   */
  public OfferRouteResolver(X402Offers offers) {
    Map<String, RouteConfig> byName = new LinkedHashMap<>();
    offers.offers().forEach((name, offer) -> {
      byName.put(name, offer.route());
      if (offer.path() != null && !offer.path().isBlank()) {
        pathOffers.add(new PathOffer(name, RoutePattern.parse(offer.path().strip())));
      }
    });
    this.routes = Collections.unmodifiableMap(byName);
  }

  @Override
  public RouteMatch resolve(HttpRequestContext context) {
    if (context.adapter() instanceof OfferSelection selection) {
      String offer = selection.selectedOffer();
      return offer == null ? null : match(offer, selection.selectedPattern());
    }
    String method = context.method() != null ? context.method() : context.adapter().getMethod();
    String offer = matchPath(method, context.path(), context.decodedPath());
    return offer == null ? null : match(offer, patternOf(offer));
  }

  /**
   * The route match of an offer.
   *
   * @param offer the offer name
   * @param pattern the matched pattern, may be {@code null}
   * @return the match, or {@code null} for an unknown offer
   */
  public RouteMatch match(String offer, String pattern) {
    RouteConfig config = routes.get(offer);
    return config == null ? null : new RouteMatch(offer, pattern, config);
  }

  /**
   * Whether any offer has a {@code path:}.
   *
   * @return {@code true} when path routes exist
   */
  public boolean hasPathOffers() {
    return !pathOffers.isEmpty();
  }

  /**
   * The {@code path:} offer of a request, for an application without a dispatcher prefix.
   *
   * @param method the HTTP method
   * @param rawPath the raw path within the application ({@code ;} parameters stripped)
   * @param decodedPath its decoded form, may be {@code null}
   * @return the offer name, or {@code null}
   * @throws AmbiguousRouteException when the forms of the path select different offers
   */
  public String matchPath(String method, String rawPath, String decodedPath) {
    return matchPath(method, rawPath, decodedPath, null, null);
  }

  /**
   * The {@code path:} offer of a request. Every form of the path is matched
   * ({@link RouteViews}); a form under the dispatcher's prefix is matched both without the prefix
   * (where handler patterns live) and whole, so an offer may be written either way. In each form
   * the first offer in declaration order whose verb matches wins, and {@code HEAD} falls back to
   * {@code GET} offers, as Spring dispatches HEAD to GET handlers; {@code OPTIONS} is matched like
   * any other method (CORS preflights are skipped before this).
   *
   * @param method the HTTP method
   * @param rawPath the raw path within the application ({@code ;} parameters stripped)
   * @param decodedPath its decoded form, may be {@code null}
   * @param containerPath the container's decoded, dot-resolved path
   *     ({@code servletPath + pathInfo}), may be {@code null}
   * @param prefix the dispatcher's path prefix such as {@code /api}, {@code null} for none
   * @return the offer name, or {@code null}
   * @throws AmbiguousRouteException when the forms of the path select different offers
   */
  public String matchPath(String method, String rawPath, String decodedPath,
      String containerPath, String prefix) {
    if (pathOffers.isEmpty() || rawPath == null) {
      return null;
    }
    List<String> found = RouteViews.select(RouteViews.forms(rawPath, decodedPath, containerPath),
        prefix, paths -> {
          String offer = find(method, paths);
          return offer == null && "HEAD".equalsIgnoreCase(method) ? find("GET", paths) : offer;
        });
    if (found.size() > 1) {
      throw new AmbiguousRouteException(found);
    }
    return found.isEmpty() ? null : found.get(0);
  }

  /**
   * The pattern of a path offer.
   *
   * @param offer the offer name
   * @return the pattern's path, or {@code null}
   */
  public String patternOf(String offer) {
    return pathOffers.stream().filter(p -> p.name().equals(offer)).findFirst()
        .map(p -> p.pattern().path()).orElse(null);
  }

  /** The first offer, in declaration order, that matches any of the paths. */
  private String find(String method, List<String> normalizedPaths) {
    for (PathOffer p : pathOffers) {
      for (String path : normalizedPaths) {
        if (p.pattern().matches(method, path)) {
          return p.name();
        }
      }
    }
    return null;
  }

  @Override
  public Map<String, RouteConfig> routes() {
    return routes;
  }
}
