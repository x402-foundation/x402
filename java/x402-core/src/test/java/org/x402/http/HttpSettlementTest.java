package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.pay;
import static org.x402.http.HttpTestSupport.routes;
import static org.x402.http.HttpTestSupport.verified;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.stubbing.Scenario;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.PaymentFlow;
import org.x402.core.SettleException;
import org.x402.core.json.X402Json;
import org.x402.core.server.CancelOptions;
import org.x402.core.server.CompletedSettlement;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.SettlePhase;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.SettleResponse;

/** Settlement processing and the settlement header helpers. */
class HttpSettlementTest {

  private final FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));

  private X402HttpResourceServer server(X402ResourceServer core, RouteConfig config) {
    X402HttpResourceServer http = http(core, routes("/r", config));
    http.initialize();
    return http;
  }

  private static RouteConfig.Builder route() {
    return RouteConfig.builder().accepts(List.of(option("$0.01").build()));
  }

  private HttpProcessResult.PaymentVerified verify(X402HttpResourceServer http) {
    PaymentPayload payload = pay(http, "/r", 0);
    return verified(http.processHttpRequest(TestAdapter.get("/r").paying(payload).context()));
  }

  private static HttpTransportContext transport(Map<String, String> responseHeaders) {
    return new HttpTransportContext(TestAdapter.get("/r").context(), new byte[0],
        responseHeaders);
  }

  @Test
  void aSuccessfulSettleReturnsPaymentResponseHeaders() {
    X402HttpResourceServer http = server(core(f), route().build());
    ProcessSettleResult result = http.processSettlement(verify(http), transport(Map.of()));
    assertThat(result).isInstanceOfSatisfying(ProcessSettleResult.Success.class, s -> {
      assertThat(s.response().success()).isTrue();
      assertThat(HeaderCodec.decodePaymentResponse(s.headers().get("PAYMENT-RESPONSE"))
          .transaction()).isEqualTo("tx-cardano:preprod");
      assertThat(s.requirements().amount()).isEqualTo("10000");
    });
    assertThat(f.settleCalls).hasValue(1);
  }

  @Test
  void aFailedSettleAnswers402WithPaymentResponseAndTheCustomBody() {
    f.settleAlways((p, r) -> SettleResponse.failure("insufficient_funds", null, "", PREPROD));
    X402HttpResourceServer http = server(core(f), route()
        .settlementFailedResponseBody((ctx, failure) ->
            new HttpResponseBody("application/json", Map.of("why", failure.errorReason())))
        .build());
    ProcessSettleResult.Failure failure = (ProcessSettleResult.Failure)
        http.processSettlement(verify(http), transport(Map.of()));
    assertThat(failure.response().errorReason()).isEqualTo("insufficient_funds");
    assertThat(failure.response().errorMessage()).isEqualTo("insufficient_funds");
    assertThat(failure.httpResponse().status()).isEqualTo(402);
    assertThat(failure.httpResponse().headers()).containsEntry("Cache-Control", "no-store")
        .containsEntry("Content-Type", "application/json").containsKey("PAYMENT-RESPONSE");
    assertThat(failure.httpResponse().body()).isEqualTo(Map.of("why", "insufficient_funds"));
  }

  @Test
  void thrownSettleErrorsMapLikeTsAndTransportErrorsPropagate() {
    X402HttpResourceServer http = server(core(f), route().build());
    HttpProcessResult.PaymentVerified v = verify(http);

    f.thenSettle((p, r) -> {
      throw new SettleException(400, new SettleResponse(false, "invalid_payload", null, "payer",
          "tx9", PREPROD, null, null, null, null));
    });
    ProcessSettleResult.Failure settleError =
        (ProcessSettleResult.Failure) http.processSettlement(v, transport(Map.of()));
    assertThat(settleError.response().transaction()).isEqualTo("tx9");
    assertThat(settleError.response().payer()).isEqualTo("payer");
    assertThat(settleError.httpResponse().body()).isEqualTo(Map.of());

    f.thenSettle((p, r) -> {
      throw new IllegalStateException("boom");
    });
    ProcessSettleResult.Failure generic =
        (ProcessSettleResult.Failure) http.processSettlement(v, transport(Map.of()));
    assertThat(generic.response().errorReason()).isEqualTo("boom");
    assertThat(generic.response().transaction()).isEmpty();
    assertThat(generic.response().network()).isEqualTo(PREPROD);

    f.thenSettle((p, r) -> {
      throw new FacilitatorResponseException.Timeout("settle", 90000);
    });
    assertThatThrownBy(() -> http.processSettlement(v, transport(Map.of())))
        .isInstanceOf(FacilitatorResponseException.class);
  }

  @Test
  void settlementOverridesAreReadFromTheResponseHeaders() {
    X402HttpResourceServer http = server(core(f), route().build());
    HttpProcessResult.PaymentVerified v = verify(http);
    http.processSettlement(v, transport(Map.of("settlement-overrides", "{\"amount\":\"50%\"}")));
    assertThat(f.settledRequirements.get(0).amount()).isEqualTo("5000");
    http.processSettlement(v, transport(Map.of("Settlement-Overrides", "not json")));
    assertThat(f.settledRequirements.get(1).amount()).isEqualTo("10000");
  }

  @Test
  void upfrontFlowsEchoTheBeforeHandlerSettlementAfterTheHandler() {
    FakeServerScheme upfront = new FakeServerScheme();
    upfront.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.UPFRONT));
    X402HttpResourceServer http = server(core(upfront, f), route().build());
    HttpProcessResult.PaymentVerified v = verify(http);
    assertThat(f.settleCalls).hasValue(1);
    ProcessSettleResult after = http.processSettlement(v, transport(Map.of()));
    assertThat(after).isInstanceOf(ProcessSettleResult.Success.class);
    assertThat(f.settleCalls).hasValue(1);

    ProcessSettleResult missing = http.processSettlement(v.paymentPayload(),
        v.paymentRequirements(), null, transport(Map.of()), null, null, null, v.routing());
    assertThat(((ProcessSettleResult.Success) missing).headers()).isEmpty();
    assertThat(f.settleCalls).hasValue(1);
  }

  @Test
  void escrowSettlesBeforeAndAfterTheHandler() {
    FakeServerScheme escrow = new FakeServerScheme();
    escrow.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.ESCROW),
        PaymentFlow.ESCROW));
    X402HttpResourceServer http = server(core(escrow, f), route().build());
    HttpProcessResult.PaymentVerified v = verify(http);
    http.processSettlement(v, transport(Map.of()));
    assertThat(f.settleCalls).hasValue(2);
  }

  @Test
  void failurePathHeadersAndCancelDispatch() {
    FakeServerScheme escrow = new FakeServerScheme();
    escrow.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.ESCROW),
        PaymentFlow.ESCROW));
    escrow.onCancel = ctx -> Fixtures.requirements(PREPROD, "1");
    X402HttpResourceServer http = server(core(escrow, f), route().build());
    HttpProcessResult.PaymentVerified v = verify(http);
    SettleResponse refund = v.cancellationDispatcher().cancel(
        new CancelOptions(CancellationReason.HANDLER_FAILED, null, 500));
    Map<String, String> headers = http.createFailurePathSettlementHeaders(refund,
        v.beforeHandlerSettlement(), v.paymentPayload(), "max-age=60");
    assertThat(headers).containsEntry("Cache-Control", "max-age=60, private")
        .containsKey("PAYMENT-RESPONSE");
    assertThat(http.createFailurePathSettlementHeaders(null, null, v.paymentPayload(), null))
        .isNull();
    CompletedSettlement deposit = v.beforeHandlerSettlement();
    assertThat(http.createCompletedSettlementHeaders(deposit, null))
        .containsEntry("Cache-Control", "private");
  }

  @Test
  void privateCacheControlFollowsTs() {
    assertThat(X402HttpResourceServer.withPrivateCacheControl(null)).isEqualTo("private");
    assertThat(X402HttpResourceServer.withPrivateCacheControl("")).isEqualTo("private");
    assertThat(X402HttpResourceServer.withPrivateCacheControl("no-cache, Private"))
        .isEqualTo("no-cache, Private");
    assertThat(X402HttpResourceServer.withPrivateCacheControl("no-cache"))
        .isEqualTo("no-cache, private");
  }

  @Test
  void aPendingThenSuccessfulSettleStaysWithinTheClientDefaultTimeout() {
    WireMockServer facilitator = new WireMockServer(options().dynamicPort());
    facilitator.start();
    try {
      facilitator.stubFor(get(urlEqualTo("/supported")).willReturn(aResponse()
          .withHeader("Content-Type", "application/json")
          .withBody(X402Json.write(supported(kind(PREPROD))))));
      facilitator.stubFor(post(urlEqualTo("/settle")).inScenario("pending")
          .whenScenarioStateIs(Scenario.STARTED).willSetStateTo("broadcast")
          .willReturn(aResponse().withFixedDelay(300).withHeader("Content-Type",
              "application/json").withBody(X402Json.write(Fixtures.pending(PREPROD, "tx1")))));
      facilitator.stubFor(post(urlEqualTo("/settle")).inScenario("pending")
          .whenScenarioStateIs("broadcast").willReturn(aResponse().withFixedDelay(300)
              .withHeader("Content-Type", "application/json")
              .withBody(X402Json.write(SettleResponse.success("tx1", PREPROD, "p")))));
      facilitator.stubFor(post(urlEqualTo("/verify")).willReturn(aResponse()
          .withHeader("Content-Type", "application/json").withBody("{\"isValid\":true}")));
      HttpFacilitatorClient client = HttpFacilitatorClient.builder()
          .url(facilitator.baseUrl()).build();
      X402ResourceServer core = X402ResourceServer.builder().facilitator(client).build();
      core.register(PREPROD, new FakeServerScheme());
      X402HttpResourceServer http = server(core, route().build());
      HttpProcessResult.PaymentVerified v = verify(http);

      long start = System.nanoTime();
      ProcessSettleResult result = http.processSettlement(v, transport(Map.of()));
      Duration elapsed = Duration.ofNanos(System.nanoTime() - start);

      assertThat(result).isInstanceOf(ProcessSettleResult.Success.class);
      facilitator.verify(2, postRequestedFor(urlEqualTo("/settle")));
      assertThat(elapsed).isLessThan(X402HttpClient.DEFAULT_REQUEST_TIMEOUT);
      // worst case with defaults: one verify-timeout hop + two settle timeouts stays below 240 s
      assertThat(client.verifyTimeout().multipliedBy(2).plus(client.settleTimeout()
          .multipliedBy(2))).isLessThan(X402HttpClient.DEFAULT_REQUEST_TIMEOUT);
    } finally {
      facilitator.stop();
    }
  }
}
