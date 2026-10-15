package org.x402.spring.offer;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.http.HttpRequestContext;
import org.x402.http.RouteConfig;
import org.x402.http.RouteMatch;
import org.x402.http.RoutePattern;
import org.x402.http.RouteResolver;

/**
 * Routes keyed by offer name. A request whose adapter carries an {@link OfferSelection} resolves to
 * that offer; otherwise the {@code path:} offers are matched as x402 route patterns (raw
 * path first, then the decoded one; {@code HEAD} also tries {@code GET}, as Spring dispatches HEAD
 * to GET handlers).
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
   * The {@code path:} offer of a request.
   *
   * @param method the HTTP method
   * @param rawPath the raw path within the application ({@code ;} parameters stripped)
   * @param decodedPath its decoded form, may be {@code null}
   * @return the offer name, or {@code null}
   */
  public String matchPath(String method, String rawPath, String decodedPath) {
    if (pathOffers.isEmpty() || rawPath == null) {
      return null;
    }
    String found = find(method, rawPath, decodedPath);
    if (found == null && "HEAD".equalsIgnoreCase(method)) {
      found = find("GET", rawPath, decodedPath);
    }
    return found;
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

  private String find(String method, String rawPath, String decodedPath) {
    String normalized = RoutePattern.normalizePath(rawPath);
    for (PathOffer p : pathOffers) {
      if (p.pattern().matches(method, normalized)) {
        return p.name();
      }
    }
    if (decodedPath != null && !decodedPath.equals(rawPath)) {
      String decoded = RoutePattern.normalizeDecodedPath(decodedPath);
      for (PathOffer p : pathOffers) {
        if (p.pattern().matches(method, decoded)) {
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
