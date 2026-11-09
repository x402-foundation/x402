package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.http.AmbiguousRouteException;
import org.x402.spring.TestBinding;

/**
 * {@code path:} offers under a DispatcherServlet prefix: each form of the path is matched in the
 * dispatcher's path space first, and forms that select different offers are ambiguous.
 */
class OfferRouteResolverPrefixTest {

  /** Offers o0, o1, … with the given paths, in declaration order. */
  private static OfferRouteResolver resolver(String... paths) {
    List<String> kv = new ArrayList<>(List.of(
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr"));
    for (int i = 0; i < paths.length; i++) {
      kv.addAll(List.of("x402.routes.o" + i + ".accepts[0].account", "net",
          "x402.routes.o" + i + ".accepts[0].price", "$1",
          "x402.routes.o" + i + ".path", paths[i]));
    }
    TestBinding.Bound bound = TestBinding.bind(kv.toArray(String[]::new));
    return new OfferRouteResolver(OfferResolver.builder(bound.properties())
        .presence(bound.present()).build().resolve());
  }

  private static String match(OfferRouteResolver routes, String rawPath, String containerPath) {
    return routes.matchPath("GET", rawPath, rawPath, containerPath, "/api");
  }

  @Test
  void offersWrittenRelativeToTheDispatcherMatchUnderItsPrefix() {
    OfferRouteResolver routes = resolver("GET /premium", "GET /api/*");
    assertThat(match(routes, "/api/premium", "/api/premium")).isEqualTo("o0");
    assertThat(match(routes, "/api/other", "/api/other")).isEqualTo("o1");
    assertThat(match(routes, "/public/../api/premium", "/api/premium")).isEqualTo("o0");
    assertThat(match(routes, "/premium", "/premium")).isEqualTo("o0");
    assertThat(match(routes, "/apiary/x", "/apiary/x")).isNull();
  }

  @Test
  void aPrefixedOfferDeclaredFirstIsNotShadowedByALaterCatchAll() {
    OfferRouteResolver routes = resolver("GET /api/premium", "GET /*");
    assertThat(match(routes, "/api/premium", "/api/premium")).isEqualTo("o0");
    assertThat(match(routes, "/api/other", "/api/other")).isEqualTo("o1");
  }

  @Test
  void aCheapDispatcherOfferCannotShadowAPaidApplicationOffer() {
    OfferRouteResolver routes = resolver("GET /cheap/*", "GET /api/premium");
    assertThatThrownBy(() -> match(routes, "/api/cheap/../premium", "/api/premium"))
        .isInstanceOf(AmbiguousRouteException.class)
        .satisfies(e -> assertThat(((AmbiguousRouteException) e).routeKeys())
            .containsExactly("o0", "o1"));
  }

  @Test
  void twoDispatcherOffersSelectedByDifferentFormsAreAmbiguous() {
    OfferRouteResolver routes = resolver("GET /cheap/*", "GET /premium");
    assertThatThrownBy(() -> match(routes, "/api/cheap/../premium", "/api/premium"))
        .isInstanceOf(AmbiguousRouteException.class);
  }

  @Test
  void headFallsBackToGetOffersAndOptionsIsStillMatched() {
    OfferRouteResolver routes = resolver("GET /premium", "/any");
    assertThat(routes.matchPath("HEAD", "/api/premium", null, "/api/premium", "/api"))
        .isEqualTo("o0");
    assertThat(routes.matchPath("OPTIONS", "/any", null, null, null)).isEqualTo("o1");
  }

  @Test
  void withoutAPrefixTheContainerFormIsStillMatched() {
    OfferRouteResolver routes = resolver("GET /premium");
    assertThat(routes.matchPath("GET", "/public/..;/premium", null, "/premium", null))
        .isEqualTo("o0");
  }
}
