package org.x402.spring.offer;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.x402.http.HttpRequestContext;
import org.x402.http.RouteMatch;
import org.x402.spring.TestAdapter;
import org.x402.spring.TestBinding;

/** Path offers without a Spring adapter, as the core uses them for plain contexts. */
class OfferRouteResolverTest {

  private static OfferRouteResolver resolver(String... paths) {
    List<String> kv = new java.util.ArrayList<>(List.of(
        "x402.accounts.net.network", "test:net",
        "x402.accounts.net.pay-to", "addr"));
    for (int i = 0; i < paths.length; i++) {
      kv.addAll(List.of("x402.routes.o" + i + ".accepts[0].account", "net",
          "x402.routes.o" + i + ".accepts[0].price", "$1"));
      if (paths[i] != null) {
        kv.addAll(List.of("x402.routes.o" + i + ".path", paths[i]));
      }
    }
    TestBinding.Bound bound = TestBinding.bind(kv.toArray(String[]::new));
    return new OfferRouteResolver(OfferResolver.builder(bound.properties())
        .presence(bound.present()).build().resolve());
  }

  @Test
  void plainContextsMatchPathOffersRawThenDecoded() {
    OfferRouteResolver routes = resolver("GET /report/*", "GET /x/y", null);
    assertThat(routes.hasPathOffers()).isTrue();
    assertThat(routes.routes()).containsOnlyKeys("o0", "o1", "o2");

    RouteMatch match = routes.resolve(TestAdapter.get("/report/q1").context());
    assertThat(match.key()).isEqualTo("o0");
    assertThat(match.pattern()).isEqualTo("/report/*");
    assertThat(routes.resolve(TestAdapter.get("/free").context())).isNull();

    HttpRequestContext decoded = TestAdapter.get("/x%252Fy").context()
        .withPaths("/x%252Fy", "/x/y");
    assertThat(routes.resolve(decoded).key()).isEqualTo("o1");
    assertThat(routes.matchPath("GET", null, null)).isNull();
    assertThat(routes.patternOf("o2")).isNull();
    assertThat(routes.match("unknown", null)).isNull();
  }

  @Test
  void headFallsBackToGetPatterns() {
    OfferRouteResolver routes = resolver("GET /report/*");
    assertThat(routes.matchPath("HEAD", "/report/q1", null)).isEqualTo("o0");
    assertThat(routes.matchPath("POST", "/report/q1", null)).isNull();
  }

  @Test
  void withoutPathOffersNothingMatches() {
    OfferRouteResolver routes = resolver((String) null);
    assertThat(routes.hasPathOffers()).isFalse();
    assertThat(routes.matchPath("GET", "/anything", "/anything")).isNull();
  }

  @Test
  void anAdapterSelectionWins() {
    OfferRouteResolver routes = resolver("GET /report/*", null);
    OfferSelection none = new SelectingAdapter(null);
    OfferSelection o1 = new SelectingAdapter("o1");
    assertThat(routes.resolve(new HttpRequestContext((SelectingAdapter) none, "GET",
        "/report/q1", null, null))).isNull();
    assertThat(routes.resolve(new HttpRequestContext((SelectingAdapter) o1, "GET", "/x", null,
        null)).key()).isEqualTo("o1");
  }

  /** An adapter carrying a selection. */
  record SelectingAdapter(String offer) implements org.x402.http.HttpAdapter, OfferSelection {
    @Override
    public String getHeader(String name) {
      return null;
    }

    @Override
    public String getMethod() {
      return "GET";
    }

    @Override
    public String getPath() {
      return "/x";
    }

    @Override
    public String getUrl() {
      return "https://api.example.com/x";
    }

    @Override
    public String selectedOffer() {
      return offer;
    }

    @Override
    public String selectedPattern() {
      return "/x";
    }
  }
}
