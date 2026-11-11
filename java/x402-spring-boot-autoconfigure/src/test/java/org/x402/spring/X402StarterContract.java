package org.x402.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.SettleResponse;
import org.x402.http.X402Headers;

/**
 * The starter contract, run against a real server on both stacks. Subclasses
 * supply the stack: {@code @SpringBootTest(webEnvironment = RANDOM_PORT)} over an app importing
 * {@link ContractApp}, plus the fixture hooks below.
 */
public abstract class X402StarterContract {

  /** The facilitator every contract app uses. */
  protected static final FakeFacilitator FACILITATOR =
      FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);

  /**
   * The contract's {@code x402.*} configuration.
   *
   * @return property name → value
   */
  public static Map<String, Object> contractProperties() {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("x402.facilitators[0].url", FACILITATOR.url());
    p.put("x402.accounts.net.network", HookRecorder.NET);
    p.put("x402.accounts.net.pay-to", "addr_net");
    p.put("x402.routes.weather.description", "Weather API");
    p.put("x402.routes.weather.accepts[0].account", "net");
    p.put("x402.routes.weather.accepts[0].price", "$0.01");
    p.put("x402.routes.premium.accepts[0].account", "net");
    p.put("x402.routes.premium.accepts[0].price", "$0.05");
    p.put("x402.routes.prepaid.accepts[0].account", "net");
    p.put("x402.routes.prepaid.accepts[0].price", "$0.10");
    p.put("x402.routes.prepaid.accepts[0].extra.assetTransferMethod", "prepaid");
    p.put("x402.routes.report.path", "GET /report/*");
    p.put("x402.routes.report.accepts[0].account", "net");
    p.put("x402.routes.report.accepts[0].price", "$0.50");
    p.put("x402.routes.overlap-path.path", "/overlap");
    p.put("x402.routes.overlap-path.accepts[0].account", "net");
    p.put("x402.routes.overlap-path.accepts[0].price", "$0.99");
    p.put("x402.routes.files.path", "GET /files/*");
    p.put("x402.routes.files.accepts[0].account", "net");
    p.put("x402.routes.files.accepts[0].price", "$0.02");
    return p;
  }

  @DynamicPropertySource
  static void x402Properties(DynamicPropertyRegistry registry) {
    contractProperties().forEach((k, v) -> registry.add(k, () -> v));
  }

  /**
   * The port of the main app.
   *
   * @return the port
   */
  protected abstract int port();

  /**
   * The main app's hook recorder.
   *
   * @return the recorder
   */
  protected abstract HookRecorder recorder();

  /**
   * Starts another app of the same stack on a random port with the contract properties plus
   * {@code overrides}, and extra configuration classes.
   *
   * @param overrides properties replacing or adding to {@link #contractProperties()}
   * @param extra extra configuration classes
   * @return the running context
   */
  protected abstract ConfigurableApplicationContext startVariant(Map<String, Object> overrides,
      Class<?>... extra);

  /**
   * A configuration requiring authentication on every request (Spring Security, this stack).
   *
   * @return the configuration class
   */
  protected abstract Class<?> securityConfiguration();

  /**
   * The property that sets this stack's context path.
   *
   * @return the property name
   */
  protected abstract String contextPathProperty();

  private String url(String path) {
    return "http://127.0.0.1:" + port() + path;
  }

  private static String variantUrl(ConfigurableApplicationContext ctx, String path) {
    return "http://127.0.0.1:" + ctx.getEnvironment().getProperty("local.server.port") + path;
  }

  private HttpResponse<String> paid(String method, String path, String mode) {
    HttpResponse<String> unpaid = TestHttp.send(method, url(path));
    assertThat(unpaid.statusCode()).as("unpaid " + path).isEqualTo(402);
    return TestHttp.send(method, url(path), X402Headers.PAYMENT_SIGNATURE,
        TestHttp.pay(unpaid, 0, mode));
  }

  @BeforeEach
  void resetFixtures() {
    FACILITATOR.reset(HookRecorder.NET, HookRecorder.MAIN);
    recorder().reset();
  }

  @Test
  void unpaidRequestGetsA402WithPaymentRequired() {
    HttpResponse<String> response = TestHttp.get(url("/weather"));

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.headers().firstValue("Cache-Control")).hasValue("no-store");
    assertThat(response.headers().firstValue("Content-Type").orElse(""))
        .startsWith("application/json");
    assertThat(response.body()).isEqualTo("{}");
    PaymentRequired required = TestHttp.required(response);
    assertThat(required.x402Version()).isEqualTo(2);
    assertThat(required.resource().url()).endsWith("/weather");
    assertThat(required.resource().description()).isEqualTo("Weather API");
    assertThat(required.accepts()).hasSize(1);
    assertThat(required.accepts().get(0).network()).isEqualTo(HookRecorder.NET);
    assertThat(required.accepts().get(0).amount()).isEqualTo("10000");
    assertThat(required.accepts().get(0).payTo()).isEqualTo("addr_net");
  }

  @Test
  void paidRequestGets200WithPaymentResponse() {
    HttpResponse<String> response = paid("GET", "/weather", null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).contains("sunny");
    SettleResponse settlement = TestHttp.settlement(response);
    assertThat(settlement).isNotNull();
    assertThat(settlement.success()).isTrue();
    assertThat(settlement.transaction()).isEqualTo("tx-1");
    assertThat(response.headers().firstValue("Cache-Control").orElse("")).contains("private");
    assertThat(FACILITATOR.count("verify")).isEqualTo(1);
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
    assertThat(recorder().settled.get()).isEqualTo(1);
  }

  @Test
  void handlerErrorStatusCancelsOnceWithoutSettling() {
    for (int status : new int[] {500, 404}) {
      recorder().reset();
      HttpResponse<String> response = paid("GET", "/fail/" + status, null);

      assertThat(response.statusCode()).isEqualTo(status);
      assertThat(response.body()).isEqualTo("failed");
      assertThat(recorder().canceled.get()).isEqualTo(1);
      assertThat(recorder().cancelReasons).containsExactly("handler_failed");
      assertThat(response.headers().firstValue(X402Headers.PAYMENT_RESPONSE)).isEmpty();
    }
    assertThat(FACILITATOR.count("settle")).isZero();
  }

  @Test
  void handlerExceptionCancelsOnceWithoutSettling() {
    HttpResponse<String> response = paid("GET", "/throw", null);

    assertThat(response.statusCode()).isEqualTo(500);
    assertThat(response.body()).doesNotContain("sunny");
    assertThat(recorder().canceled.get()).isEqualTo(1);
    assertThat(recorder().cancelReasons).containsExactly("handler_threw");
    assertThat(FACILITATOR.count("settle")).isZero();
  }

  @Test
  void settleFailureAnswers402AndDiscardsTheHandlerBody() {
    HttpResponse<String> response = paid("GET", "/weather", "settle-fail");

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(response.body()).doesNotContain("sunny");
    SettleResponse settlement = TestHttp.settlement(response);
    assertThat(settlement.success()).isFalse();
    assertThat(settlement.errorReason()).isEqualTo("insufficient_funds");
  }

  @Test
  void pendingSettlementIsRetriedOnce() {
    HttpResponse<String> response = paid("GET", "/weather", "pending");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(TestHttp.settlement(response).success()).isTrue();
    assertThat(FACILITATOR.count("settle")).isEqualTo(2);
  }

  @Test
  void invalidPaymentGets402WithTheReason() {
    HttpResponse<String> response = paid("GET", "/weather", "verify-invalid");

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(TestHttp.required(response).error()).isEqualTo("invalid_payload");
    assertThat(FACILITATOR.count("settle")).isZero();
  }

  @Test
  void malformedSignatureIsTreatedAsUnpaid() {
    HttpResponse<String> response = TestHttp.get(url("/weather"),
        X402Headers.PAYMENT_SIGNATURE, "not-base64-json");

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(FACILITATOR.count("verify")).isZero();
  }

  @Test
  void facilitatorTransportErrorAnswers502() {
    HttpResponse<String> unpaid = TestHttp.get(url("/weather"));
    FACILITATOR.verifyAnswers(200, "this is not json");
    HttpResponse<String> response = TestHttp.get(url("/weather"), X402Headers.PAYMENT_SIGNATURE,
        TestHttp.pay(unpaid, 0, null));

    assertThat(response.statusCode()).isEqualTo(502);
    assertThat(response.body()).contains("error");
  }

  @Test
  void upfrontFlowWithHandlerFailureCancelsOnceAndEchoesTheReceipt() {
    HttpResponse<String> response = paid("GET", "/prepaid/fail", null);

    assertThat(response.statusCode()).isEqualTo(500);
    assertThat(recorder().canceled.get()).isEqualTo(1);
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
    SettleResponse receipt = TestHttp.settlement(response);
    assertThat(receipt).isNotNull();
    assertThat(receipt.success()).isTrue();
  }

  @Test
  void unknownOfferFailsTheContext() {
    assertThatThrownBy(() -> startVariant(Map.of(), ContractApp.UnknownOfferController.class)
        .close())
        .hasStackTraceContaining("@X402Payment(\"nope\")")
        .hasStackTraceContaining("weather");
  }

  @Test
  void classLevelAnnotationAppliesAndMethodLevelOverrides() {
    assertThat(TestHttp.required(TestHttp.get(url("/class/inherits"))).accepts().get(0).amount())
        .isEqualTo("10000");
    assertThat(TestHttp.required(TestHttp.get(url("/class/overrides"))).accepts().get(0)
        .amount()).isEqualTo("50000");
  }

  @Test
  void pathVariablesReachThePaidHandler() {
    HttpResponse<String> response = paid("GET", "/items/42", null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("item 42");
  }

  @Test
  void consumesConditionDecidesWhetherTheHandlerIsPaid() {
    HttpResponse<String> json = TestHttp.sendBody("POST", url("/consumes"), "application/json",
        "{\"q\":1}");
    assertThat(json.statusCode()).isEqualTo(402);

    HttpResponse<String> text = TestHttp.sendBody("POST", url("/consumes"), "text/plain", "q");
    assertThat(text.statusCode()).isEqualTo(415);

    HttpResponse<String> paid = TestHttp.sendBody("POST", url("/consumes"), "application/json",
        "{\"q\":1}", X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(json, 0, null));
    assertThat(paid.statusCode()).isEqualTo(200);
    assertThat(paid.body()).isEqualTo("consumed 7");
  }

  @Test
  void headOnAPaidGetIsCharged() {
    HttpResponse<String> response = paid("HEAD", "/weather", null);

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
  }

  @Test
  void corsPreflightIsNeverCharged() {
    HttpResponse<String> response = TestHttp.send("OPTIONS", url("/cors"),
        "Origin", "https://app.example", "Access-Control-Request-Method", "GET");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.headers().firstValue(X402Headers.PAYMENT_REQUIRED)).isEmpty();
    assertThat(TestHttp.get(url("/cors")).statusCode()).isEqualTo(402);
  }

  @Test
  void aMoreSpecificFreeHandlerStaysFree() {
    HttpResponse<String> response = TestHttp.get(url("/items/free"));

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("free");
  }

  @Test
  void yamlPathRouteProtectsAnUnannotatedHandler() {
    HttpResponse<String> unpaid = TestHttp.get(url("/report/q1"));
    assertThat(unpaid.statusCode()).isEqualTo(402);
    assertThat(TestHttp.required(unpaid).accepts().get(0).amount()).isEqualTo("500000");

    HttpResponse<String> response = paid("GET", "/report/q1", null);
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("report q1");
  }

  @Test
  void pathRoutesMatchUnderAContextPathWithMatrixParametersAndEncodedSlashes() {
    try (ConfigurableApplicationContext ctx = startVariant(
        Map.of(contextPathProperty(), "/api"))) {
      HttpResponse<String> matrix = TestHttp.get(variantUrl(ctx, "/api/report/q1;jsessionid=abc"));
      assertThat(matrix.statusCode()).isEqualTo(402);
      assertThat(TestHttp.required(matrix).accepts().get(0).amount()).isEqualTo("500000");

      HttpResponse<String> slash = TestHttp.get(variantUrl(ctx, "/api/files/a%2Fb"));
      assertThat(slash.statusCode()).isEqualTo(402);
      assertThat(TestHttp.required(slash).accepts().get(0).amount()).isEqualTo("20000");

      assertThat(TestHttp.get(variantUrl(ctx, "/report/q1")).statusCode()).isEqualTo(404);
    }
  }

  @Test
  void annotationWinsOverAnOverlappingPathRoute() {
    HttpResponse<String> response = TestHttp.get(url("/overlap"));

    assertThat(response.statusCode()).isEqualTo(402);
    assertThat(TestHttp.required(response).accepts().get(0).amount()).isEqualTo("10000");
  }

  @Test
  void springSecurityAnswers401BeforeX402Answers402() {
    try (ConfigurableApplicationContext ctx = startVariant(Map.of(
        "spring.autoconfigure.exclude", ""), securityConfiguration())) {
      assertThat(TestHttp.get(variantUrl(ctx, "/weather")).statusCode()).isEqualTo(401);
    }
  }

  @Test
  void disabledStarterLeavesHandlersFree() {
    try (ConfigurableApplicationContext ctx = startVariant(Map.of("x402.enabled", "false"))) {
      HttpResponse<String> response = TestHttp.get(variantUrl(ctx, "/weather"));
      assertThat(response.statusCode()).isEqualTo(200);
      assertThat(response.body()).contains("sunny");
    }
  }

  @Test
  void aPaidNoContentHandlerIsSettled() {
    HttpResponse<String> response = paid("GET", "/no-content", null);

    assertThat(response.statusCode()).isEqualTo(204);
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
  }
}
