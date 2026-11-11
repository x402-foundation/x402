package org.x402.http;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Function;

/**
 * The forms of one request path and the routes they select. A path reaches a framework in several
 * forms: as sent (percent-encoded, with {@code ;} parameters), decoded, and with dot segments
 * resolved the way a servlet container does before dispatching. Route matching is the paywall
 * boundary, so a paid route must not be reachable through a form the matcher did not look at:
 * every form is matched, forms that select no route are ignored, and when the remaining forms
 * select different routes the request is ambiguous ({@link AmbiguousRouteException}, answered
 * with 400). Adapted from #4129 ({@code PathNormalizer}, {@code RouteMatcher}, Stefano Amorelli).
 *
 * <p>An adapter whose dispatcher is mapped under a path prefix (a Spring {@code DispatcherServlet}
 * at {@code /api/*}) passes that prefix: a form under it is offered to the matcher both with the
 * prefix stripped (the path the dispatcher routes on) and whole, and the first route in
 * declaration order that matches either wins, so a route may be written with or without the
 * prefix and the usual first-match rule decides. The forms are compared afterwards, so a cheap
 * route one form selects cannot hide a paid route another form selects.
 */
public final class RouteViews {

  private RouteViews() {}

  /**
   * The forms of a request path: the raw path normalized ({@link RoutePattern#normalizePath}) and
   * canonicalized ({@link RoutePattern#canonicalPath}) and, when a different decoded path is
   * known, the decoded path normalized and canonicalized. Duplicates are dropped; order is kept.
   *
   * @param rawPath the path as sent, still percent-encoded
   * @param decodedPath the framework's decoded path, may be {@code null}
   * @param extraDecoded further decoded forms the adapter knows (a servlet container's
   *     {@code servletPath + pathInfo}), {@code null} entries ignored
   * @return the forms
   */
  public static List<String> forms(String rawPath, String decodedPath, String... extraDecoded) {
    Set<String> forms = new LinkedHashSet<>();
    forms.add(RoutePattern.normalizePath(rawPath));
    forms.add(RoutePattern.canonicalPath(rawPath));
    if (decodedPath != null && !decodedPath.isEmpty() && !decodedPath.equals(rawPath)) {
      forms.add(RoutePattern.normalizeDecodedPath(decodedPath));
      forms.add(RoutePattern.canonicalDecodedPath(decodedPath));
    }
    for (String extra : extraDecoded) {
      if (extra != null && !extra.isEmpty()) {
        forms.add(RoutePattern.normalizeDecodedPath(extra));
        forms.add(RoutePattern.canonicalDecodedPath(extra));
      }
    }
    return List.copyOf(forms);
  }

  /**
   * The distinct routes the forms select, in the order found: none (no payment), one (that
   * route), or several (ambiguous).
   *
   * @param <T> the route type
   * @param forms the forms, from {@link #forms}
   * @param prefix the dispatcher's path prefix such as {@code /api}, or {@code null}/empty for none
   * @param match the first route, in declaration order, that matches any of the given normalized
   *     paths (one path per form; two, stripped and whole, for a form under the prefix), or
   *     {@code null}
   * @return the distinct routes
   */
  public static <T> List<T> select(List<String> forms, String prefix,
      Function<List<String>, T> match) {
    String p = normalizePrefix(prefix);
    List<T> routes = new ArrayList<>(1);
    for (String form : forms) {
      List<String> paths = p != null && under(form, p) ? List.of(strip(form, p), form)
          : List.of(form);
      T route = match.apply(paths);
      if (route != null && !routes.contains(route)) {
        routes.add(route);
      }
    }
    return routes;
  }

  /**
   * Whether a path is the prefix itself or lies below it, at a segment boundary and ignoring case
   * ({@code /api/x} is under {@code /api}; {@code /apiary/x} is not).
   *
   * @param path a normalized path
   * @param prefix a normalized prefix without a trailing slash
   * @return {@code true} when the path is under the prefix
   */
  static boolean under(String path, String prefix) {
    if (path.length() < prefix.length()
        || !path.regionMatches(true, 0, prefix, 0, prefix.length())) {
      return false;
    }
    return path.length() == prefix.length() || path.charAt(prefix.length()) == '/';
  }

  private static String strip(String path, String prefix) {
    String rest = path.substring(prefix.length());
    return rest.isEmpty() ? "/" : rest;
  }

  private static String normalizePrefix(String prefix) {
    if (prefix == null || prefix.isEmpty()) {
      return null;
    }
    String p = RoutePattern.normalizeDecodedPath(prefix);
    return "/".equals(p) ? null : p;
  }
}
