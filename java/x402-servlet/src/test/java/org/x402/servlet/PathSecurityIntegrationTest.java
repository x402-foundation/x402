package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.servlet.TestServers.paymentFor;
import static org.x402.servlet.TestServers.route;
import static org.x402.servlet.TestServers.text;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.eclipse.jetty.http.UriCompliance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.http.RouteConfig;

/**
 * No request path reaches a paid servlet without payment, under Jetty's default URI handling and
 * the lenient modes some deployments enable. An unprotected control server shows which encodings
 * the container dispatches to the paid servlet; the protected server must answer every one of
 * them with 402, or 400 when a cheaper route also matches. Ported from #4129's
 * {@code PathSecurityIntegrationTest} (Stefano Amorelli); this SDK has no free carve-out routes,
 * so the tiered case uses a cheap and a premium route only.
 */
class PathSecurityIntegrationTest {

  private static final String SECRET = "premium-secret";

  private static final List<String> ATTACK_PATHS = List.of(
      "/premium",
      "/public/../premium",
      "/public/%2e%2e/premium",
      "/public/%2E%2E/premium",
      "/public/.%2e/premium",
      "/public/..;/premium",
      "/premium;jsessionid=1",
      "/premium;a=b",
      "//premium",
      "/./premium",
      "/%2e/premium",
      "/%70remium",
      "/%70%72%65%6d%69%75%6d",
      "/premium/",
      "/premium/.",
      "/Premium",
      "/premium%2F",
      "/public%2F..%2Fpremium",
      "/public%2f..%2fpremium",
      "/public/%2e%2e%2fpremium",
      "/x/%2e%2e/premium",
      "/premium%3Bx",
      "/premium%00",
      "/premium?x=1",
      "/public/premium");

  private static final List<String> TIERED_ATTACK_PATHS = List.of(
      "/premium",
      "/public/../premium",
      "/public/x/../../premium",
      "/cheap/../premium",
      "/cheap/x/../../premium",
      "/public/%2e%2e/premium",
      "/cheap/%2e%2e/premium",
      "/cheap/.%2e/premium",
      "/public/..;/premium",
      "/cheap/..;/premium",
      "/cheap/%2E%2E/premium");

  private static JettyServer server(UriCompliance compliance, Map<String, RouteConfig> routes)
      throws Exception {
    JettyServer jetty = new JettyServer(compliance)
        .servlet("/premium", text(SECRET))
        .servlet("/cheap/*", text("cheap"))
        .servlet("/public/*", text("public"));
    if (routes != null) {
      FakeFacilitatorClient facilitator =
          new FakeFacilitatorClient("f", Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
      jetty.filter(new PaymentFilter(TestServers.http(new FakeServerScheme(), facilitator, routes,
          new CopyOnWriteArrayList<>()), null, false));
    }
    return jetty.start();
  }

  @ParameterizedTest(name = "{0}")
  @ValueSource(strings = {"DEFAULT", "LEGACY", "UNSAFE"})
  void neverServesThePaidResourceWithoutPayment(String compliance) throws Exception {
    UriCompliance mode = UriCompliance.valueOf(compliance);
    List<String> reachedSecret = new ArrayList<>();
    try (JettyServer control = server(mode, null);
        JettyServer protectedServer = server(mode, Map.of("GET /premium", route("$0.001")))) {
      for (String path : ATTACK_PATHS) {
        RawHttp.Response unprotected = RawHttp.send(control.port(), "GET", path);
        RawHttp.Response response = RawHttp.send(protectedServer.port(), "GET", path);
        assertThat(response.text()).as(path + " leaked the paid resource").doesNotContain(SECRET);
        if (unprotected.text().contains(SECRET)) {
          reachedSecret.add(path);
          assertThat(response.status()).as(path + " reaches the paid servlet").isEqualTo(402);
          assertThat(response.text()).as(path).contains("PAYMENT-REQUIRED: ");
        }
      }
    }
    assertThat(reachedSecret).as("the control server dispatches these to the paid servlet")
        .contains("/premium", "/public/../premium", "/premium;jsessionid=1", "/./premium",
            "/%70remium");
  }

  @ParameterizedTest(name = "{0}")
  @ValueSource(strings = {"DEFAULT", "LEGACY", "UNSAFE"})
  void neverServesThePremiumResourceThroughACheaperRoute(String compliance) throws Exception {
    UriCompliance mode = UriCompliance.valueOf(compliance);
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /cheap/*", route("$0.001"));
    routes.put("GET /premium", route("$10"));
    List<String> reachedSecret = new ArrayList<>();
    try (JettyServer control = server(mode, null);
        JettyServer protectedServer = server(mode, routes)) {
      String cheapPayment = paymentFor(RawHttp.send(protectedServer.port(), "GET", "/cheap/item"));
      for (String path : TIERED_ATTACK_PATHS) {
        if (!RawHttp.send(control.port(), "GET", path).text().contains(SECRET)) {
          continue;
        }
        reachedSecret.add(path);
        RawHttp.Response unpaid = RawHttp.send(protectedServer.port(), "GET", path);
        RawHttp.Response paidCheap = RawHttp.send(protectedServer.port(), "GET", path,
            cheapPayment);
        for (RawHttp.Response response : List.of(unpaid, paidCheap)) {
          assertThat(response.text()).as(path + " leaked the premium resource")
              .doesNotContain(SECRET);
          assertThat(response.status()).as(path + ": " + response.text()).isIn(400, 402);
        }
      }
      assertThat(RawHttp.send(protectedServer.port(), "GET", "/cheap/item", cheapPayment).text())
          .endsWith("cheap");
      assertThat(RawHttp.send(protectedServer.port(), "GET", "/premium", cheapPayment).status())
          .isEqualTo(402);
    }
    assertThat(reachedSecret).as("the control server dispatches the dot-segment paths")
        .contains("/public/../premium", "/cheap/../premium");
  }
}
