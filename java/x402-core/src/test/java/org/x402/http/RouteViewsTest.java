package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Path forms, per-form precedence of the dispatcher's path space, and ambiguity across forms
 * ({@link RouteViews}, {@link AmbiguousRouteException}).
 */
class RouteViewsTest {

  /** First pattern (in declaration order) that matches any of the paths, verb ignored. */
  private static String first(Map<String, RoutePattern> routes, List<String> paths) {
    for (Map.Entry<String, RoutePattern> e : routes.entrySet()) {
      for (String path : paths) {
        if (e.getValue().matchesNormalized(path)) {
          return e.getKey();
        }
      }
    }
    return null;
  }

  private static Map<String, RoutePattern> routes(String... nameAndPattern) {
    Map<String, RoutePattern> m = new LinkedHashMap<>();
    for (int i = 0; i < nameAndPattern.length; i += 2) {
      m.put(nameAndPattern[i], RoutePattern.parse(nameAndPattern[i + 1]));
    }
    return m;
  }

  private static List<String> select(Map<String, RoutePattern> routes, String prefix,
      String rawPath, String decodedPath) {
    return RouteViews.select(RouteViews.forms(rawPath, decodedPath), prefix,
        paths -> first(routes, paths));
  }

  @Test
  void formsAreNormalizedCanonicalizedAndDeduplicated() {
    assertThat(RouteViews.forms("/a", null)).containsExactly("/a");
    assertThat(RouteViews.forms("/public/..;/premium", null))
        .containsExactly("/public/..;/premium", "/premium");
    assertThat(RouteViews.forms("/x%252Fy", "/x/y")).containsExactly("/x%2Fy", "/x/y");
    assertThat(RouteViews.forms("/a", "/a")).containsExactly("/a");
    assertThat(RouteViews.forms("/a", "/a", "/b/../c", null)).containsExactly("/a", "/b/../c", "/c");
  }

  @Test
  void underIsSegmentAwareAndIgnoresCase() {
    assertThat(RouteViews.under("/api", "/api")).isTrue();
    assertThat(RouteViews.under("/api/x", "/api")).isTrue();
    assertThat(RouteViews.under("/API/x", "/api")).isTrue();
    assertThat(RouteViews.under("/apiary/x", "/api")).isFalse();
    assertThat(RouteViews.under("/ap", "/api")).isFalse();
  }

  @Test
  void anOfferWrittenWithThePrefixKeepsItsPlaceBeforeALaterCatchAll() {
    Map<String, RoutePattern> routes = routes("premium", "GET /api/premium", "basic", "GET /*");
    assertThat(select(routes, "/api", "/api/premium", null)).containsExactly("premium");
    assertThat(select(routes, "/api", "/api/other", null)).containsExactly("basic");
  }

  @Test
  void aFormUnderThePrefixMatchesWithOrWithoutItInDeclarationOrder() {
    Map<String, RoutePattern> routes = routes("p", "GET /premium", "c", "GET /api/*");
    assertThat(select(routes, "/api", "/api/premium", null)).containsExactly("p");
    assertThat(select(routes, "/api", "/api/other", null)).containsExactly("c");
    assertThat(select(routes, "/api", "/public/../api/premium", null)).containsExactly("p");
    assertThat(select(routes, "/api", "/premium", null)).containsExactly("p");
    assertThat(select(routes, "/api", "/apiary/x", null)).isEmpty();
    assertThat(select(routes, "/api/", "/api/premium", null)).containsExactly("p");
    assertThat(select(routes, "", "/api/premium", null)).containsExactly("c");
  }

  @Test
  void aCheapLookupRouteCannotShadowAPaidApplicationRoute() {
    Map<String, RoutePattern> routes = routes("cheap", "GET /cheap/*", "premium", "GET /api/premium");
    assertThat(select(routes, "/api", "/api/cheap/../premium", null))
        .containsExactly("cheap", "premium");
    assertThat(select(routes, "/api", "/api/cheap/..;/premium", null))
        .containsExactly("cheap", "premium");
  }

  @Test
  void bothRoutesInTheLookupSpaceAreAmbiguousToo() {
    Map<String, RoutePattern> routes = routes("cheap", "GET /cheap/*", "premium", "GET /premium");
    assertThat(select(routes, "/api", "/api/cheap/../premium", null))
        .containsExactly("cheap", "premium");
  }

  @Test
  void aCatchAllAndASpecificRouteAgreeWhenEveryFormSelectsTheSameOne() {
    assertThat(select(routes("all", "GET /*", "premium", "GET /premium"), "/api", "/api/premium",
        null)).containsExactly("all");
    assertThat(select(routes("premium", "GET /premium", "all", "GET /*"), "/api", "/api/premium",
        null)).containsExactly("premium");
  }

  @Test
  void theExceptionCarriesTheRouteKeysForLogsOnly() {
    AmbiguousRouteException e = new AmbiguousRouteException(List.of("GET /cheap/*", "GET /premium"));
    assertThat(e.routeKeys()).containsExactly("GET /cheap/*", "GET /premium");
    assertThat(e).hasMessageContaining("invalid_path");
    assertThatThrownBy(() -> e.routeKeys().add("x"))
        .isInstanceOf(UnsupportedOperationException.class);
  }
}
