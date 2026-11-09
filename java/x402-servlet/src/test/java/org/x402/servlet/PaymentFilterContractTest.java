package org.x402.servlet;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.servlet.TestServers.paymentFor;
import static org.x402.servlet.TestServers.route;
import static org.x402.servlet.TestServers.servlet;
import static org.x402.servlet.TestServers.text;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.eclipse.jetty.http.UriCompliance;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.Fixtures;
import org.x402.core.PaymentFlow;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.http.HeaderCodec;
import org.x402.http.RouteConfig;
import org.x402.http.X402Headers;

/**
 * The Spring starter's contract ({@code X402StarterContract}) for the cases that apply to a plain
 * servlet filter, on Jetty: the money paths must behave exactly as in the starter.
 */
class PaymentFilterContractTest {

  private final FakeFacilitatorClient facilitator =
      new FakeFacilitatorClient("f", Fixtures.supported(Fixtures.kind(Fixtures.PREPROD)));
  private final List<VerifiedPaymentCanceledContext> cancels = new CopyOnWriteArrayList<>();
  private JettyServer jetty;

  @AfterEach
  void stop() throws Exception {
    if (jetty != null) {
      jetty.close();
    }
  }

  private int start(FakeServerScheme scheme, String contextPath, UriCompliance compliance)
      throws Exception {
    Map<String, RouteConfig> routes = new LinkedHashMap<>();
    routes.put("GET /weather", route("$0.01"));
    routes.put("GET /fail", route("$0.01"));
    routes.put("GET /throw", route("$0.01"));
    routes.put("GET /no-content", route("$0.01"));
    routes.put("GET /files/*", route("$0.02"));
    PaymentFilter filter = new PaymentFilter(TestServers.http(scheme, facilitator, routes, cancels),
        null, false);
    jetty = new JettyServer(compliance, contextPath)
        .servlet("/weather", text("weather"))
        .servlet("/fail", servlet((request, response) -> {
          response.setStatus(500);
          response.getWriter().print("boom");
        }))
        .servlet("/throw", servlet((request, response) -> {
          throw new IllegalStateException("handler exploded");
        }))
        .servlet("/no-content", servlet((request, response) -> response.setStatus(204)))
        .servlet("/files/*", text("file"))
        .filter(filter)
        .start();
    return jetty.port();
  }

  private int start() throws Exception {
    return start(new FakeServerScheme(), "/", UriCompliance.DEFAULT);
  }

  private static RawHttp.Response paid(int port, String path) {
    RawHttp.Response unpaid = RawHttp.send(port, "GET", path);
    assertThat(unpaid.status()).as("unpaid " + path).isEqualTo(402);
    return RawHttp.send(port, "GET", path, paymentFor(unpaid));
  }

  @Test
  void unpaidRequestGetsA402WithPaymentRequired() throws Exception {
    RawHttp.Response response = RawHttp.send(start(), "GET", "/weather");
    assertThat(response.status()).isEqualTo(402);
    assertThat(response.header(X402Headers.PAYMENT_REQUIRED)).isNotBlank();
    assertThat(response.body()).doesNotContain("weather");
  }

  @Test
  void paidRequestGets200WithPaymentResponse() throws Exception {
    RawHttp.Response response = paid(start(), "/weather");
    assertThat(response.status()).isEqualTo(200);
    assertThat(response.body()).contains("weather");
    assertThat(response.header(X402Headers.PAYMENT_RESPONSE)).isNotBlank();
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
  }

  @Test
  void handlerErrorStatusCancelsOnceWithoutSettling() throws Exception {
    RawHttp.Response response = paid(start(), "/fail");
    assertThat(response.status()).isEqualTo(500);
    assertThat(facilitator.settleCalls.get()).isZero();
    assertThat(cancels).singleElement()
        .satisfies(c -> assertThat(c.reason()).isEqualTo(CancellationReason.HANDLER_FAILED));
  }

  @Test
  void handlerExceptionCancelsOnceWithoutSettling() throws Exception {
    RawHttp.Response response = paid(start(), "/throw");
    assertThat(response.status()).isEqualTo(500);
    assertThat(facilitator.settleCalls.get()).isZero();
    assertThat(cancels).singleElement()
        .satisfies(c -> assertThat(c.reason()).isEqualTo(CancellationReason.HANDLER_THREW));
  }

  @Test
  void settleFailureAnswers402AndDiscardsTheHandlerBody() throws Exception {
    facilitator.thenSettle((p, r) -> SettleResponse.failure("insufficient_funds", "no funds",
        null, Fixtures.PREPROD));
    RawHttp.Response response = paid(start(), "/weather");
    assertThat(response.status()).isEqualTo(402);
    assertThat(response.body()).doesNotContain("weather");
  }

  @Test
  void pendingSettlementIsRetriedOnce() throws Exception {
    facilitator.thenSettle((p, r) -> Fixtures.pending(Fixtures.PREPROD, "tx1"));
    RawHttp.Response response = paid(start(), "/weather");
    assertThat(response.status()).isEqualTo(200);
    assertThat(facilitator.settleCalls.get()).isEqualTo(2);
  }

  @Test
  void invalidPaymentGets402WithTheReason() throws Exception {
    int port = start();
    RawHttp.Response unpaid = RawHttp.send(port, "GET", "/weather");
    facilitator.thenVerify((p, r) -> VerifyResponse.invalid("insufficient_funds", "no funds"));
    RawHttp.Response response = RawHttp.send(port, "GET", "/weather", paymentFor(unpaid));
    assertThat(response.status()).isEqualTo(402);
    PaymentRequired required = HeaderCodec.decodePaymentRequired(
        response.header(X402Headers.PAYMENT_REQUIRED));
    assertThat(required.error()).contains("insufficient_funds");
    assertThat(facilitator.settleCalls.get()).isZero();
  }

  @Test
  void malformedSignatureIsTreatedAsUnpaid() throws Exception {
    RawHttp.Response response = RawHttp.send(start(), "GET", "/weather",
        X402Headers.PAYMENT_SIGNATURE + ": not-a-payment");
    assertThat(response.status()).isEqualTo(402);
    assertThat(response.body()).doesNotContain("weather");
  }

  @Test
  void facilitatorTransportErrorAnswers502() throws Exception {
    facilitator.thenSettle((p, r) -> {
      throw new FacilitatorResponseException("facilitator unreachable", 0, null);
    });
    RawHttp.Response response = paid(start(), "/weather");
    assertThat(response.status()).isEqualTo(502);
    assertThat(response.body()).doesNotContain("weather");
  }

  @Test
  void upfrontFlowWithHandlerFailureCancelsOnceAndEchoesTheReceipt() throws Exception {
    FakeServerScheme upfront = new FakeServerScheme();
    upfront.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.UPFRONT));
    RawHttp.Response response = paid(start(upfront, "/", UriCompliance.DEFAULT), "/fail");
    assertThat(response.status()).isEqualTo(500);
    assertThat(response.header(X402Headers.PAYMENT_RESPONSE)).isNotBlank();
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
    assertThat(cancels).hasSize(1);
  }

  @Test
  void headOnAPaidGetIsCharged() throws Exception {
    assertThat(RawHttp.send(start(), "HEAD", "/weather").status()).isEqualTo(402);
  }

  @Test
  void corsPreflightIsNeverCharged() throws Exception {
    RawHttp.Response response = RawHttp.send(start(), "OPTIONS", "/weather",
        "Origin: https://shop.example", "Access-Control-Request-Method: GET");
    assertThat(response.status()).isNotEqualTo(402);
  }

  @Test
  void pathRoutesMatchUnderAContextPathWithMatrixParametersAndEncodedSlashes() throws Exception {
    int port = start(new FakeServerScheme(), "/ctx", UriCompliance.LEGACY);
    assertThat(RawHttp.send(port, "GET", "/ctx/weather;jsessionid=abc").status()).isEqualTo(402);
    RawHttp.Response slash = RawHttp.send(port, "GET", "/ctx/files/a%2Fb");
    assertThat(slash.status()).isEqualTo(402);
    assertThat(HeaderCodec.decodePaymentRequired(slash.header(X402Headers.PAYMENT_REQUIRED))
        .accepts().get(0).amount()).isEqualTo(HeaderCodec.decodePaymentRequired(
            RawHttp.send(port, "GET", "/ctx/files/x").header(X402Headers.PAYMENT_REQUIRED))
            .accepts().get(0).amount());
    assertThat(RawHttp.send(port, "GET", "/weather").status()).isEqualTo(404);
  }

  @Test
  void aPaidNoContentHandlerIsSettled() throws Exception {
    RawHttp.Response response = paid(start(), "/no-content");
    assertThat(response.status()).isEqualTo(204);
    assertThat(response.header(X402Headers.PAYMENT_RESPONSE)).isNotBlank();
    assertThat(facilitator.settleCalls.get()).isEqualTo(1);
  }
}
