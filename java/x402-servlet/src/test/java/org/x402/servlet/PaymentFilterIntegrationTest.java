package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.servlet.TestServers.paymentFor;
import static org.x402.servlet.TestServers.route;
import static org.x402.servlet.TestServers.servlet;
import static org.x402.servlet.TestServers.text;

import jakarta.servlet.AsyncContext;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpUpgradeHandler;
import jakarta.servlet.http.WebConnection;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.eclipse.jetty.http.UriCompliance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.http.RouteConfig;
import org.x402.http.X402Headers;
import org.x402.http.X402HttpResourceServer;

/** What only the plain filter does: dispatch types, buffering guards, startup and the paywall. */
class PaymentFilterIntegrationTest {

  private final FakeFacilitatorClient facilitator =
      new FakeFacilitatorClient("f", Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
  private final List<VerifiedPaymentCanceledContext> cancels = new CopyOnWriteArrayList<>();
  private final Map<String, RouteConfig> routes = new LinkedHashMap<>();
  private JettyServer jetty;

  @AfterEach
  void stop() throws Exception {
    if (jetty != null) {
      jetty.close();
    }
  }

  private X402HttpResourceServer http() {
    return TestServers.http(new FakeServerScheme(), facilitator, routes, cancels);
  }

  private JettyServer jetty(PaymentFilter filter) {
    jetty = new JettyServer(UriCompliance.DEFAULT).filter(filter);
    return jetty;
  }

  private static RawHttp.Response paid(int port, String path) {
    RawHttp.Response unpaid = RawHttp.send(port, "GET", path);
    assertThat(unpaid.status()).as("unpaid " + path).isEqualTo(402);
    return RawHttp.send(port, "GET", path, paymentFor(unpaid));
  }

  @Test
  void aBrowserGetsThePaywallPage() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http())).servlet("/weather", text("weather")).start().port();
    RawHttp.Response response = RawHttp.send(port, "GET", "/weather",
        "Accept: text/html,application/xhtml+xml", "User-Agent: Mozilla/5.0 (X11; Linux x86_64)");
    assertThat(response.status()).isEqualTo(402);
    assertThat(response.header("Content-Type")).contains("text/html");
  }

  @Test
  void pathFormsSelectingDifferentRoutesAnswer400InvalidPath() throws Exception {
    routes.put("GET /cheap/*", route("$0.01"));
    routes.put("GET /weather", route("$0.90"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/weather", text("weather")).servlet("/cheap/*", text("cheap")).start().port();
    RawHttp.Response response = RawHttp.send(port, "GET", "/cheap/../weather");
    assertThat(response.status()).isEqualTo(400);
    assertThat(response.body()).contains("invalid_path").doesNotContain("weather");
    assertThat(facilitator.settleCalls.get()).isZero();
  }

  @Test
  void aRouteAwaitingItsFacilitatorAnswers503UntilABackgroundResyncSucceeds() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    facilitator.failSupported(new IllegalStateException("facilitator down"));
    PaymentFilter filter = new PaymentFilter(http(), null, false, new ResourceServerSync.Settings(
        Duration.ofSeconds(2), Duration.ofMillis(50), Duration.ofMillis(200)));
    int port = jetty(filter).servlet("/weather", text("weather")).start().port();
    RawHttp.Response down = RawHttp.send(port, "GET", "/weather");
    assertThat(down.status()).isEqualTo(503);
    assertThat(down.header("Retry-After")).isEqualTo("5");

    facilitator.supported(() -> Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
    long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
    int status = down.status();
    while (status != 402 && System.nanoTime() < deadline) {
      Thread.sleep(50);
      status = RawHttp.send(port, "GET", "/weather").status();
    }
    assertThat(status).isEqualTo(402);
  }

  @Test
  void aFreeUrlThatForwardsToAPaidPathIsCharged() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/weather", text("weather"))
        .servlet("/go", servlet((request, response) ->
            request.getRequestDispatcher("/weather").forward(request, response)))
        .start().port();
    RawHttp.Response response = RawHttp.send(port, "GET", "/go");
    assertThat(response.status()).isEqualTo(402);
    assertThat(response.body()).doesNotContain("weather");
  }

  @Test
  void aForwardInsideAPaidRequestIsChargedOnce() throws Exception {
    routes.put("GET /bundle", route("$0.01"));
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/weather", text("weather"))
        .servlet("/bundle", servlet((request, response) ->
            request.getRequestDispatcher("/weather").forward(request, response)))
        .start().port();
    RawHttp.Response response = paid(port, "/bundle");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.body()).contains("weather");
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
  }

  @Test
  void anIncludedResourceCannotReplaceThePaidStatus() throws Exception {
    routes.put("GET /page", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/fragment", servlet((request, response) -> {
          response.setStatus(418);
          response.setHeader("X-Fragment", "set");
          response.sendError(500);
        }))
        .servlet("/page", servlet((request, response) -> {
          response.getWriter().print("page");
          request.getRequestDispatcher("/fragment").include(request, response);
        }))
        .start().port();
    RawHttp.Response response = paid(port, "/page");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.header("X-Fragment")).isNull();
    assertThat(response.body()).contains("page");
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
  }

  @Test
  void everyRedirectFormIsHeldBackAndReplayedWithServlet60Methods() throws Exception {
    routes.put("GET /moved", route("$0.01"));
    routes.put("GET /found", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/moved", servlet((request, response) -> response.sendRedirect("/new-home", 301)))
        .servlet("/found", servlet((request, response) -> response.sendRedirect("/new-home")))
        .start().port();
    RawHttp.Response moved = paid(port, "/moved");
    assertThat(moved.status()).isEqualTo(301);
    assertThat(moved.header("Location")).endsWith("/new-home");
    assertThat(moved.header(X402Headers.PAYMENT_RESPONSE)).isNotBlank();
    RawHttp.Response found = paid(port, "/found");
    assertThat(found.status()).isEqualTo(302);
    assertThat(found.header("Location")).endsWith("/new-home");
    assertThat(facilitator.settleCalls.get()).isEqualTo(2);
  }

  @Test
  void theHandlersCacheControlIsMergedWithPrivate() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/weather", servlet((request, response) -> {
          response.setHeader("Cache-Control", "max-age=60");
          response.getWriter().print("weather");
        }))
        .start().port();
    RawHttp.Response response = paid(port, "/weather");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.header("Cache-Control")).contains("private").contains("max-age=60");
  }

  @Test
  void asyncProcessingOnAPaidRouteIsRefusedAndNothingIsSettled() throws Exception {
    routes.put("GET /async", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/async", servlet((request, response) -> request.startAsync()))
        .start().port();
    RawHttp.Response response = paid(port, "/async");
    assertThat(response.status()).isEqualTo(500);
    assertThat(facilitator.settleCalls.get()).isZero();
    assertThat(cancels).singleElement()
        .satisfies(c -> assertThat(c.reason()).isEqualTo(CancellationReason.HANDLER_THREW));
  }

  @Test
  void aProtocolUpgradeOnAPaidRouteIsRefusedAndNothingIsSettled() throws Exception {
    routes.put("GET /ws", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/ws", servlet((request, response) -> request.upgrade(Echo.class)))
        .start().port();
    RawHttp.Response response = paid(port, "/ws");
    assertThat(response.status()).isEqualTo(500);
    assertThat(facilitator.settleCalls.get()).isZero();
  }

  @Test
  void settlementOverridesNeverReachTheClient() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/weather", servlet((request, response) -> {
          response.setHeader(X402Headers.SETTLEMENT_OVERRIDES, "{}");
          response.getWriter().print("weather");
        }))
        .start().port();
    RawHttp.Response response = paid(port, "/weather");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.header(X402Headers.SETTLEMENT_OVERRIDES)).isNull();
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
  }

  @Test
  void aFreeAsyncEndpointStillWorksBehindTheFilter() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/events", servlet((request, response) -> {
          AsyncContext async = request.startAsync();
          async.start(() -> {
            try {
              async.getResponse().getWriter().print("event");
            } catch (IOException e) {
              throw new UncheckedIOException(e);
            }
            async.complete();
          });
        }))
        .start().port();
    RawHttp.Response response = RawHttp.send(port, "GET", "/events");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.body()).contains("event");
  }

  @Test
  void anUnroutedRequestPassesThroughUntouched() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    int port = jetty(new PaymentFilter(http(), null, false))
        .servlet("/free", text("free")).start().port();
    RawHttp.Response response = RawHttp.send(port, "GET", "/free");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.body()).contains("free");
  }

  @Test
  void aRouteNoResyncCanHealStopsTheApplication() {
    routes.put("GET /weather", RouteConfig.builder().accepts(List.of(
        org.x402.http.PaymentOption.builder().scheme("exact").network("cardano:mainnet")
            .payTo(Fixtures.PAY_TO).price("$0.01").build())).build());
    PaymentFilter filter = new PaymentFilter(http(), null, false);
    assertThatThrownBy(() -> filter.init(null)).isInstanceOf(ServletException.class)
        .hasMessageContaining("x402 initialization failed");
    filter.destroy();
  }

  @Test
  void aServerTheApplicationAlreadySyncedIsNotSyncedAgain() throws Exception {
    routes.put("GET /weather", route("$0.01"));
    X402HttpResourceServer http = http();
    http.initialize();
    int calls = facilitator.supportedCalls.get();
    PaymentFilter filter = new PaymentFilter(http);
    filter.init(null);
    assertThat(facilitator.supportedCalls.get()).isEqualTo(calls);
    filter.destroy();
  }

  /** An upgrade handler the paid route asks for (and never gets). */
  public static final class Echo implements HttpUpgradeHandler {
    @Override
    public void init(WebConnection connection) {
      // never reached
    }

    @Override
    public void destroy() {
      // never reached
    }
  }
}
