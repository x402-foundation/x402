package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.MAINNET;
import static org.x402.core.Fixtures.PAY_TO;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.routes;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.PaymentFlow;
import org.x402.core.server.FacilitatorCapabilityError;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.Money;
import org.x402.http.RouteValidationError.Reason;

/**
 * Route validation at initialize, plus the facilitator pin, ambiguity and timeout-budget rules.
 */
class RouteValidationTest {

  private final FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
  private final FakeFacilitatorClient b = new FakeFacilitatorClient("B",
      supported(kind(PREPROD), kind(MAINNET)));

  private static RouteConfig accepts(PaymentOption.Builder... options) {
    return RouteConfig.builder().accepts(List.of(options).stream()
        .map(PaymentOption.Builder::build).toList()).build();
  }

  private static RouteConfigurationError routeError(Runnable r) {
    try {
      r.run();
    } catch (RouteConfigurationError e) {
      return e;
    }
    throw new AssertionError("expected RouteConfigurationError");
  }

  @Test
  void initializeReportsEveryTsErrorWithTsMessages() {
    FakeServerScheme scheme = new FakeServerScheme();
    X402ResourceServer core = X402ResourceServer.builder().facilitator(a).build();
    core.register(PREPROD, scheme);
    core.register(MAINNET, scheme);
    X402HttpResourceServer http = http(core, routes(
        "GET /a", accepts(option("$1").network("eip155:8453")),
        "GET /b", accepts(option("$1").network(MAINNET))));
    RouteConfigurationError e = routeError(http::initialize);
    assertThat(e.errors()).extracting(RouteValidationError::reason)
        .containsExactly(Reason.MISSING_SCHEME, Reason.MISSING_FACILITATOR);
    assertThat(e.errors()).extracting(RouteValidationError::message).containsExactly(
        "Route \"GET /a\": No scheme implementation registered for \"exact\" on network "
            + "\"eip155:8453\"",
        "Route \"GET /b\": Facilitator does not support scheme \"exact\" on network "
            + "\"cardano:mainnet\"");
    assertThat(e).hasMessageStartingWith("x402 Route Configuration Errors:\n  - Route \"GET /a\"");
    assertThat(e.errors().get(0).optionIndex()).isZero();
    assertThat(e.onlyAwaitingFacilitators()).isFalse();
    assertThat(X402HttpResourceServer.isFatalStartupError(e)).isTrue();
    assertThat(http.state().errorsFor("GET /b")).hasSize(1);
    assertThat(http.state().affectedRoutes()).containsExactly("GET /a", "GET /b");
  }

  @Test
  void unsupportedMethodsAndFlowsFailAlreadyInTheConstructor() {
    X402ResourceServer core = core(a);
    RouteConfigurationError atm = routeError(() -> http(core, routes("/x",
        accepts(option("$1").extra(map("assetTransferMethod", "masumi"))))));
    assertThat(atm.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.UNSUPPORTED_ASSET_TRANSFER_METHOD);
      assertThat(err.message()).isEqualTo("Route \"/x\": [x402] Scheme \"exact\" does not "
          + "support assetTransferMethod \"masumi\". Supported: default.");
    });
    RouteConfigurationError flow = routeError(() -> http(core, routes("/x",
        accepts(option("$1").extra(map("paymentFlow", "upfront"))))));
    assertThat(flow.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.UNSUPPORTED_PAYMENT_FLOW);
      assertThat(err.message()).isEqualTo("Route \"/x\": [x402] Scheme \"exact\" "
          + "assetTransferMethod \"default\" does not support paymentFlow \"upfront\". "
          + "Supported: authorization (default: authorization).");
    });
    // a missing scheme is only reported at initialize (schemes may be registered later)
    X402ResourceServer empty = X402ResourceServer.builder().facilitator(a).build();
    http(empty, routes("/x", accepts(option("$1"))));
  }

  @Test
  void pinsNameTheFacilitatorAndOptionAndMatchOnlyEffectiveIdentifiers() {
    RouteConfigurationError unknown = routeError(() -> http(core(a, b), routes("/x",
        accepts(option("$1"), option("$2").facilitator("C")))));
    assertThat(unknown).isInstanceOf(IllegalArgumentException.class);
    assertThat(unknown.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.UNKNOWN_FACILITATOR);
      assertThat(err.optionIndex()).isEqualTo(1);
      assertThat(err.facilitator()).isEqualTo("C");
      assertThat(err.message()).contains("option 1").contains("\"C\"").contains("A, B");
    });

    FakeFacilitatorClient team = new FakeFacilitatorClient("team/", supported(kind(PREPROD)));
    FakeFacilitatorClient local = new FakeFacilitatorClient("local", supported(kind(MAINNET)));
    X402HttpResourceServer ok = http(core(team, local), routes("/x", accepts(
        option("$1").facilitator("team"), option("$2").facilitator("team/"),
        option("$3").network(MAINNET).facilitator("local"))));
    ok.initialize();

    HttpFacilitatorClient byUrl = HttpFacilitatorClient.builder().url("https://f.example/")
        .build();
    HttpFacilitatorClient named = HttpFacilitatorClient.builder().url("https://g.example")
        .identifier("cardano").build();
    X402ResourceServer remote = X402ResourceServer.builder().facilitators(List.of(byUrl, named))
        .build();
    remote.register(PREPROD, new FakeServerScheme());
    http(remote, routes("/x", accepts(option("$1").facilitator("https://f.example"),
        option("$2").facilitator("cardano"))));
    assertThat(routeError(() -> http(remote, routes("/x",
        accepts(option("$1").facilitator("https://g.example"))))).errors())
        .extracting(RouteValidationError::reason).containsExactly(Reason.UNKNOWN_FACILITATOR);
  }

  @Test
  void aPinnedFacilitatorLackingTheKindOrCapabilityIsReported() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.capabilityCheck = k -> "B".equals(String.valueOf(k.extra() == null ? null
        : k.extra().get("who"))) ? "no masumi at B" : null;
    FakeFacilitatorClient bWithExtra = new FakeFacilitatorClient("B",
        supported(kind(PREPROD, map("who", "B"))));
    X402ResourceServer core = X402ResourceServer.builder().facilitators(List.of(a, bWithExtra))
        .build();
    core.register(PREPROD, scheme);
    core.register(MAINNET, scheme);
    X402HttpResourceServer http = http(core, routes("/x", accepts(
        option("$1").network(MAINNET).facilitator("A"),
        option("$2").facilitator("B"))));
    RouteConfigurationError e = routeError(http::initialize);
    assertThat(e.errors()).extracting(RouteValidationError::reason)
        .containsExactly(Reason.MISSING_FACILITATOR, Reason.FACILITATOR_CAPABILITY);
    assertThat(e.errors().get(0).facilitator()).isEqualTo("A");
    assertThat(e.errors().get(0).optionIndex()).isZero();
    assertThat(e.errors().get(0).retryable()).isFalse();
    assertThat(e.errors().get(1).message()).contains("option 1").contains("\"B\"")
        .contains("no masumi at B");
  }

  @Test
  void overlappingOptionsWithDifferentRoutingPoliciesFail() {
    // price-ref over preprod + mainnet with different pins: networks differ → fine
    X402HttpResourceServer refs = http(core(a, b), routes("/x", RouteConfig.builder().accepts(
        List.of(PaymentOption.builder().scheme("exact").network(PREPROD).payTo(PAY_TO)
                .price(ctx -> new Money("$1")).facilitator("A").build(),
            PaymentOption.builder().scheme("exact").network(MAINNET).payTo(PAY_TO)
                .price(ctx -> new Money("$1")).facilitator("B").build())).build()));
    refs.initialize();

    // two same-network accounts with different static pay-to and different pins → fine
    X402HttpResourceServer accounts = http(core(a, b), routes("/x", accepts(
        option("$1").payTo("addr_one").facilitator("A"),
        option("$1").payTo("addr_two").facilitator("B"))));
    accounts.initialize();

    // equal core fields, extra {a:1} vs {b:2}: a union payload matches both → error
    X402HttpResourceServer union = http(core(a, b), routes("/x", accepts(
        option("$1").extra(map("a", 1)).facilitator("A"),
        option("$1").extra(map("b", 2)).facilitator("B"))));
    RouteConfigurationError e = routeError(union::initialize);
    assertThat(e.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.AMBIGUOUS_OPTIONS);
      assertThat(err.message()).contains("options 0 and 1");
    });

    // a dynamic payTo may equal the other → fails closed
    X402HttpResourceServer dynamicPayTo = http(core(a, b), routes("/x", RouteConfig.builder()
        .accepts(List.of(option("$1").facilitator("A").build(),
            PaymentOption.builder().scheme("exact").network(PREPROD).payTo(ctx -> PAY_TO)
                .price("$1").facilitator("B").build())).build()));
    assertThat(routeError(dynamicPayTo::initialize).errors()).singleElement()
        .extracting(RouteValidationError::reason).isEqualTo(Reason.AMBIGUOUS_OPTIONS);

    // nested objects recurse; a conflicting shared key makes them disjoint
    X402HttpResourceServer nested = http(core(a, b), routes("/x", accepts(
        option("$1").extra(map("p", map("x", 1))).facilitator("A"),
        option("$1").extra(map("p", map("x", 2))).facilitator("B"))));
    nested.initialize();

    // same build facilitator and no failover → same policy → no check
    X402HttpResourceServer samePolicy = http(core(a, b), routes("/x", accepts(
        option("$1"), option("$1").extra(map("b", 2)))));
    samePolicy.initialize();
  }

  @Test
  void withFailoverPinnedAndUnpinnedIdenticalOptionsFail() {
    RouteConfig config = RouteConfig.builder().failover(true).accepts(List.of(
        option("$1").facilitator("A").build(), option("$1").build())).build();
    X402HttpResourceServer http = http(core(a, b), routes("/x", config));
    assertThat(routeError(http::initialize).errors()).singleElement()
        .extracting(RouteValidationError::reason).isEqualTo(Reason.AMBIGUOUS_OPTIONS);

    RouteConfig noFailover = RouteConfig.builder().accepts(List.of(
        option("$1").facilitator("A").build(), option("$1").build())).build();
    http(core(a, b), routes("/x", noFailover)).initialize();
  }

  @Test
  void aPartialOutageAffectsOnlyRoutesItMightServeAndHealsOnReSync() {
    FakeFacilitatorClient down = new FakeFacilitatorClient("down", supported(kind(MAINNET)))
        .failSupported(new FacilitatorResponseException("down", 0, null));
    X402HttpResourceServer http = http(core(a, down), routes(
        "/preprod", accepts(option("$1")),
        "/mainnet", accepts(option("$1").network(MAINNET))));
    RouteConfigurationError e = routeError(http::initialize);
    assertThat(e.onlyAwaitingFacilitators()).isTrue();
    assertThat(X402HttpResourceServer.isFatalStartupError(e)).isTrue();
    assertThat(e.errors()).singleElement().satisfies(err -> {
      assertThat(err.route()).isEqualTo("/mainnet");
      assertThat(err.retryable()).isTrue();
    });
    HttpServerState state = http.state();
    assertThat(state.failedFacilitators()).containsExactly("down");
    assertThat(state.affectedRoutes()).containsExactly("/mainnet");

    assertThat(http.processHttpRequest(TestAdapter.get("/mainnet").context()))
        .isInstanceOfSatisfying(HttpProcessResult.RouteUnavailable.class, u -> {
          assertThat(u.route()).isEqualTo("/mainnet");
          assertThat(u.retryable()).isTrue();
        });
    assertThat(http.processHttpRequest(TestAdapter.get("/preprod").context()))
        .isInstanceOf(HttpProcessResult.PaymentError.class);

    down.supported(() -> supported(kind(MAINNET)));
    HttpServerState healed = http.initialize();
    assertThat(healed.errors()).isEmpty();
    assertThat(http.state()).isSameAs(healed);
    assertThat(healed.snapshot()).isSameAs(http.server().snapshot());
    assertThat(http.processHttpRequest(TestAdapter.get("/mainnet").context()))
        .isInstanceOf(HttpProcessResult.PaymentError.class);
  }

  @Test
  void noKindsAtAllIsRetryableAndAffectsEveryRoute() {
    FakeFacilitatorClient down = new FakeFacilitatorClient("down", null)
        .failSupported(new FacilitatorResponseException("down", 0, null));
    X402HttpResourceServer http = http(core(down), routes("/x", accepts(option("$1"))));
    assertThatThrownBy(http::initialize).isInstanceOf(IllegalStateException.class)
        .isNotInstanceOf(FacilitatorCapabilityError.class);
    assertThat(X402HttpResourceServer.isFatalStartupError(new IllegalStateException())).isFalse();
    assertThat(http.state().affectedRoutes()).containsExactly("/x");
  }

  @Test
  void aCapabilityProblemOfAnUnusedSchemeIsStillFatal() {
    FakeServerScheme picky = new FakeServerScheme();
    picky.capabilityCheck = k -> "unsupported";
    X402ResourceServer core = X402ResourceServer.builder().facilitator(b).build();
    core.register(PREPROD, new FakeServerScheme());
    core.register(MAINNET, picky);
    X402HttpResourceServer http = http(core, routes("/x", accepts(option("$1"))));
    RouteConfigurationError e = routeError(http::initialize);
    assertThat(e.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.FACILITATOR_CAPABILITY);
      assertThat(err.route()).isNull();
      assertThat(err.message()).isEqualTo("exact on cardano:mainnet: unsupported");
    });
    assertThat(X402HttpResourceServer.isFatalStartupError(new FacilitatorCapabilityError(
        List.of("x")))).isTrue();
  }

  @Test
  void theWorstPaymentPathAbove240SecondsWarns() {
    FakeFacilitatorClient fast = new FakeFacilitatorClient("A", supported(kind(PREPROD)))
        .timeouts(Duration.ofSeconds(15), Duration.ofSeconds(90));
    FakeFacilitatorClient slow = new FakeFacilitatorClient("B", supported(kind(PREPROD)))
        .timeouts(Duration.ofSeconds(120), Duration.ofSeconds(90));
    HttpServerState withFailover = http(core(fast, slow), routes("/x", RouteConfig.builder()
        .failover(true).accepts(List.of(option("$1").build())).build())).initialize();
    assertThat(withFailover.warnings()).singleElement().asString()
        .contains("Route \"/x\" option 0").contains("315 s").contains("240 s");

    HttpServerState noFailover = http(core(fast, slow), routes("/x",
        accepts(option("$1")))).initialize();
    assertThat(noFailover.warnings()).isEmpty();
  }

  @Test
  void wildcardRoutesWithBazaarWarn() {
    HttpServerState state = http(core(a), routes("/api/*", RouteConfig.builder()
        .accepts(List.of(option("$1").build())).extensions(map("bazaar", Map.of())).build()))
        .initialize();
    assertThat(state.warnings()).singleElement().asString().contains("Wildcard (*)");
  }

  @Test
  void upfrontOptionsValidateWithTheirFlow() {
    FakeServerScheme upfront = new FakeServerScheme();
    upfront.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT,
        PaymentFlow.AUTHORIZATION), PaymentFlow.UPFRONT));
    X402HttpResourceServer http = http(core(upfront, a), routes("/x",
        accepts(option("$1").extra(map("paymentFlow", "authorization")))));
    assertThat(http.initialize().errors()).isEmpty();
  }
}
