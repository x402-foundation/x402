package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.routes;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeFacilitatorClient;

/**
 * The core resolver charges every form of a path a servlet container may dispatch to a paid
 * route, and refuses (400) a path whose forms select different routes. Uses only API that existed
 * before the hardening, so these vectors fail on behaviour against the old resolver. Vectors from
 * #4129 (Stefano Amorelli) and the 2026-11-09 path-matching design.
 */
class PatternRouteResolverHardeningTest {

  private static final RouteConfig PREMIUM = route();
  private static final RouteConfig CHEAP = route();

  private static RouteConfig route() {
    return RouteConfig.builder().accepts(List.of(option("$0.01").build())).build();
  }

  private static RouteMatch resolve(Map<String, RouteConfig> routes, String method, String path) {
    return new PatternRouteResolver(routes).resolve(TestAdapter.request(method, path).context());
  }

  private static X402HttpResourceServer server(Map<String, RouteConfig> routes) {
    X402HttpResourceServer http = http(
        core(new FakeFacilitatorClient("f", supported(kind(PREPROD)))), routes);
    http.initialize();
    return http;
  }

  @ParameterizedTest
  @ValueSource(strings = {"/public/..;/premium", "/public/%2e%2e/premium", "/public/%2E%2E/premium",
      "/public/.%2e/premium", "/./premium", "/%2e/premium", "/premium/.", "/premium;jsessionid=1",
      "//premium", "/premium/", "/%70remium", "/Premium"})
  void everyFormAContainerDispatchesToThePaidRouteIsCharged(String path) {
    RouteMatch match = resolve(routes("GET /premium", PREMIUM), "GET", path);
    assertThat(match).as(path).isNotNull();
    assertThat(match.key()).isEqualTo("GET /premium");
  }

  @ParameterizedTest
  @ValueSource(strings = {"/premium%3Bx", "/premium%2F", "/public/premium"})
  void pathsThatDoNotReachThePaidRouteStayFree(String path) {
    assertThat(resolve(routes("GET /premium", PREMIUM), "GET", path)).as(path).isNull();
  }

  @ParameterizedTest
  @ValueSource(strings = {"/cheap/../premium", "/cheap/..;/premium", "/cheap/%2E%2E/premium",
      "/cheap/x/../../premium"})
  void aPathWhoseFormsSelectACheapAndAPaidRouteIsRefusedWith400(String path) {
    X402HttpResourceServer http = server(routes("GET /cheap/*", CHEAP, "GET /premium", PREMIUM));
    HttpRequestContext context = TestAdapter.get(path).context();
    HttpProcessResult result = http.processHttpRequest(context);
    assertThat(result).as(path).isInstanceOf(HttpProcessResult.PaymentError.class);
    HttpProcessResult.PaymentError error = (HttpProcessResult.PaymentError) result;
    assertThat(error.status()).isEqualTo(400);
    assertThat(error.body()).isEqualTo(Map.of("error", "invalid_path"));
    assertThat(error.response().headers()).containsEntry("Cache-Control", "no-store");
    assertThat(http.requiresPayment(context)).isTrue();
  }

  @Test
  void aPathOnlyTheCheapRouteSelectsStillGetsItsOwn402() {
    X402HttpResourceServer http = server(routes("GET /cheap/*", CHEAP, "GET /premium", PREMIUM));
    HttpProcessResult result = http.processHttpRequest(TestAdapter.get("/cheap/item").context());
    assertThat(result).isInstanceOf(HttpProcessResult.PaymentError.class);
    assertThat(((HttpProcessResult.PaymentError) result).status()).isEqualTo(402);
  }

  @Test
  void anEncodedSlashThatSplitsIntoTwoRoutesIsAmbiguous() {
    X402HttpResourceServer http = server(routes("/items/:id", PREMIUM, "/items/*", CHEAP));
    HttpRequestContext context = TestAdapter.get("/items/a%2Fb").context()
        .withPaths("/items/a%2Fb", "/items/a/b");
    HttpProcessResult result = http.processHttpRequest(context);
    assertThat(result).isInstanceOf(HttpProcessResult.PaymentError.class);
    assertThat(((HttpProcessResult.PaymentError) result).status()).isEqualTo(400);
  }

  @Test
  void aRouteWithoutAVerbLeavesTheCorsPreflightFreeButAnExplicitOptionsRouteMatches() {
    assertThat(resolve(routes("/x", PREMIUM), "OPTIONS", "/x")).isNull();
    assertThat(resolve(routes("/x", PREMIUM), "GET", "/x")).isNotNull();
    assertThat(resolve(routes("OPTIONS /x", PREMIUM), "OPTIONS", "/x")).isNotNull();
  }

  @Test
  void headFallsBackToTheGetRoute() {
    RouteMatch match = resolve(routes("GET /premium", PREMIUM), "HEAD", "/premium");
    assertThat(match).isNotNull();
    assertThat(match.key()).isEqualTo("GET /premium");
    assertThat(resolve(routes("POST /premium", PREMIUM), "HEAD", "/premium")).isNull();
  }
}
