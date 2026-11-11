package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.error;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.pay;
import static org.x402.http.HttpTestSupport.routes;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.PaymentFlow;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.VerifyResponse;
import org.x402.http.RouteValidationError.Reason;

/** Route validation edge cases and the HTTP flow. */
class RouteValidationEdgeCasesTest {

  private static FakeFacilitatorClient down() {
    return new FakeFacilitatorClient("down", null)
        .failSupported(new FacilitatorResponseException("down", 0, null));
  }

  private static FakeServerScheme withScript() {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.flows.put("script", PaymentFlow.Config.authorizationOnly());
    return scheme;
  }

  private static FakeServerScheme rejecting(String who) {
    FakeServerScheme scheme = new FakeServerScheme();
    scheme.capabilityCheck = k -> k.extra() != null && who.equals(k.extra().get("who"))
        ? "bad " + who : null;
    return scheme;
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
  void s1AmbiguityComparesTheWireFormExtra() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    X402HttpResourceServer http = http(core(withScript(), a, b), routes("/x", RouteConfig.builder()
        .accepts(List.of(
            option("$1").extra(map("assetTransferMethod", "default")).facilitator("A").build(),
            option("$1").extra(map("assetTransferMethod", "script")).facilitator("B").build()))
        .build()));
    assertThat(routeError(http::initialize).errors()).singleElement()
        .extracting(RouteValidationError::reason).isEqualTo(Reason.AMBIGUOUS_OPTIONS);
  }

  @Test
  void s2AnOwnersCapabilityProblemDoesNotBlockOptionsPinnedElsewhere() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A",
        supported(kind(PREPROD, map("who", "A"))));
    FakeFacilitatorClient b = new FakeFacilitatorClient("B",
        supported(kind(PREPROD, map("who", "B"))));
    X402HttpResourceServer http = http(core(rejecting("A"), a, b), routes("/x",
        RouteConfig.builder().accepts(List.of(option("$1").facilitator("B").build())).build()));
    assertThat(http.initialize().errors()).isEmpty();
  }

  @Test
  void s2CapabilityAndAmbiguityErrorsAreRetryableWhileAFacilitatorIsDown() {
    FakeFacilitatorClient a = new FakeFacilitatorClient("A",
        supported(kind(PREPROD, map("who", "A"))));
    X402HttpResourceServer capability = http(core(rejecting("A"), down(), a), routes("/x",
        RouteConfig.builder().accepts(List.of(option("$1").build())).build()));
    RouteConfigurationError e = routeError(capability::initialize);
    assertThat(e.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.FACILITATOR_CAPABILITY);
      assertThat(err.retryable()).isTrue();
    });
    assertThat(e.onlyAwaitingFacilitators()).isTrue();

    FakeFacilitatorClient b = new FakeFacilitatorClient("B", supported(kind(PREPROD)));
    FakeFacilitatorClient plain = new FakeFacilitatorClient("A", supported(kind(PREPROD)));
    X402HttpResourceServer ambiguous = http(core(new FakeServerScheme(), down(), plain, b),
        routes("/x", RouteConfig.builder().accepts(List.of(option("$1").build(),
            option("$1").facilitator("B").build())).build()));
    RouteConfigurationError amb = routeError(ambiguous::initialize);
    assertThat(amb.errors()).singleElement().satisfies(err -> {
      assertThat(err.reason()).isEqualTo(Reason.AMBIGUOUS_OPTIONS);
      assertThat(err.retryable()).isTrue();
    });

    X402HttpResourceServer pinnedAlive = http(core(new FakeServerScheme(), down(), plain, b),
        routes("/x", RouteConfig.builder().accepts(List.of(option("$1").facilitator("A")
            .build(), option("$1").facilitator("B").build())).build()));
    assertThat(routeError(pinnedAlive::initialize).errors()).singleElement()
        .extracting(RouteValidationError::retryable).isEqualTo(false);
  }

  @Test
  void o1SkipHandlerOnAnUpfrontFlowWarnsThatNothingWasSettled() {
    FakeServerScheme upfront = new FakeServerScheme();
    upfront.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.UPFRONT));
    FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
    X402ResourceServer core = core(upfront, f);
    core.onBeforeVerify(ctx -> BeforeResult.skip(VerifyResponse.valid("p")));
    core.onAfterVerify(ctx -> AfterVerifyResult.skipHandler(null));
    X402HttpResourceServer http = http(core, routes("/u", RouteConfig.builder()
        .accepts(List.of(option("$1").build())).build()));
    http.initialize();
    PaymentPayload payload = pay(http, "/u", 0);

    List<LogRecord> records = new CopyOnWriteArrayList<>();
    Handler handler = new Handler() {
      @Override
      public void publish(LogRecord record) {
        records.add(record);
      }

      @Override
      public void flush() {}

      @Override
      public void close() {}
    };
    Logger logger = Logger.getLogger(X402HttpResourceServer.class.getName());
    logger.addHandler(handler);
    try {
      HttpProcessResult.PaymentError done = error(http.processHttpRequest(
          TestAdapter.get("/u").paying(payload).context()));
      assertThat(done.status()).isEqualTo(200);
    } finally {
      logger.removeHandler(handler);
    }
    assertThat(f.settleCalls).hasValue(0);
    assertThat(records).anySatisfy(r -> assertThat(r.getMessage())
        .contains("skipHandler").contains("upfront").contains("not settled"));
  }

  @Test
  void o2EscrowCountsFourSettlesInTheTimeoutBudget() {
    FakeServerScheme escrow = new FakeServerScheme();
    escrow.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.ESCROW),
        PaymentFlow.ESCROW));
    FakeFacilitatorClient a = new FakeFacilitatorClient("A", supported(kind(PREPROD)))
        .timeouts(Duration.ofSeconds(15), Duration.ofSeconds(90));
    HttpServerState state = http(core(escrow, a), routes("/e", RouteConfig.builder()
        .accepts(List.of(option("$1").build())).build())).initialize();
    assertThat(state.warnings()).singleElement().asString().contains("375 s")
        .contains("4 × settle");
  }
}
