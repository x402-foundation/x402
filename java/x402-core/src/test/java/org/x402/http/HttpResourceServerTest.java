package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.x402.core.Fixtures.PREPROD;
import static org.x402.core.Fixtures.kind;
import static org.x402.core.Fixtures.map;
import static org.x402.core.Fixtures.supported;
import static org.x402.http.HttpTestSupport.core;
import static org.x402.http.HttpTestSupport.error;
import static org.x402.http.HttpTestSupport.http;
import static org.x402.http.HttpTestSupport.option;
import static org.x402.http.HttpTestSupport.pay;
import static org.x402.http.HttpTestSupport.paymentRequired;
import static org.x402.http.HttpTestSupport.routes;
import static org.x402.http.HttpTestSupport.verified;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorResponseException;
import org.x402.core.FakeFacilitatorClient;
import org.x402.core.FakeServerScheme;
import org.x402.core.PaymentFlow;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.SkipHandlerDirective;
import org.x402.core.server.X402ResourceServer;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.Money;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.VerifyResponse;

/** The HTTP resource server's request processing. */
class HttpResourceServerTest {

  private final FakeFacilitatorClient f = new FakeFacilitatorClient("f", supported(kind(PREPROD)));
  private final X402ResourceServer core = core(f);

  private X402HttpResourceServer server(RouteConfig config) {
    X402HttpResourceServer http = http(core, routes("GET /weather", config));
    http.initialize();
    return http;
  }

  private static RouteConfig.Builder route() {
    return RouteConfig.builder().accepts(List.of(option("$0.01").build()))
        .description("Weather API").mimeType("application/json");
  }

  @Test
  void unprotectedRoutesNeedNoPayment() {
    X402HttpResourceServer http = server(route().build());
    assertThat(http.processHttpRequest(TestAdapter.get("/free").context()))
        .isInstanceOf(HttpProcessResult.NoPaymentRequired.class);
    assertThat(http.requiresPayment(TestAdapter.get("/weather").context())).isTrue();
    assertThat(http.requiresPayment(TestAdapter.request("POST", "/weather").context())).isFalse();
  }

  @Test
  void anUnpaidRequestGets402WithPaymentRequiredAndNoStore() {
    X402HttpResourceServer http = server(route().serviceName("Weather Co").tags(List.of("w"))
        .build());
    HttpProcessResult.PaymentError e = error(
        http.processHttpRequest(TestAdapter.get("/weather").context()));
    assertThat(e.status()).isEqualTo(402);
    assertThat(e.headers()).containsEntry("Content-Type", "application/json")
        .containsEntry("Cache-Control", "no-store").containsKey("PAYMENT-REQUIRED");
    assertThat(e.body()).isEqualTo(Map.of());
    assertThat(e.html()).isFalse();
    PaymentRequired required = paymentRequired(e);
    assertThat(required.error()).isEqualTo("Payment required");
    assertThat(required.resource().url()).isEqualTo("https://api.example.com/weather");
    assertThat(required.resource().description()).isEqualTo("Weather API");
    assertThat(required.resource().serviceName()).isEqualTo("Weather Co");
    assertThat(required.resource().tags()).containsExactly("w");
    assertThat(required.accepts()).singleElement()
        .satisfies(r -> assertThat(r.amount()).isEqualTo("10000"));
  }

  @Test
  void aCustomUnpaidBodyAndResourceUrlAreUsed() {
    X402HttpResourceServer http = server(route().resource("https://cdn.example.com/w")
        .description(null).mimeType(null)
        .unpaidResponseBody(ctx -> new HttpResponseBody("text/plain", "pay " + ctx.path()))
        .build());
    HttpProcessResult.PaymentError e = error(
        http.processHttpRequest(TestAdapter.get("/weather").context()));
    assertThat(e.headers()).containsEntry("Content-Type", "text/plain");
    assertThat(e.body()).isEqualTo("pay /weather");
    PaymentRequired required = paymentRequired(e);
    assertThat(required.resource().url()).isEqualTo("https://cdn.example.com/w");
    assertThat(required.resource().description()).isEmpty();
    assertThat(required.resource().mimeType()).isEmpty();
  }

  @Test
  void browsersGetThePaywall() {
    X402HttpResourceServer http = server(route().build());
    HttpProcessResult.PaymentError fallback = error(
        http.processHttpRequest(TestAdapter.get("/weather").browser().context()));
    assertThat(fallback.status()).isEqualTo(402);
    assertThat(fallback.html()).isTrue();
    assertThat(fallback.headers()).containsEntry("Content-Type", "text/html")
        .containsKey("PAYMENT-REQUIRED");
    assertThat((String) fallback.body()).contains("<title>Payment Required</title>")
        .doesNotContain("weather");

    http.registerPaywallProvider((required, config) -> "<p>" + required.accepts().size()
        + (config == null ? "" : config.appName()) + "</p>");
    assertThat(error(http.processHttpRequest(TestAdapter.get("/weather").browser().context(),
        new PaywallConfig("App", null, null, null, true))).body()).isEqualTo("<p>1App</p>");

    X402HttpResourceServer custom = server(route().customPaywallHtml("<custom/>").build());
    assertThat(error(custom.processHttpRequest(TestAdapter.get("/weather").browser().context()))
        .body()).isEqualTo("<custom/>");
    assertThat(error(custom.processHttpRequest(TestAdapter.get("/weather")
        .header("Accept", "text/html").context())).html()).isFalse();
  }

  @Test
  void protectedRequestHooksMayGrantOrAbort() {
    X402HttpResourceServer http = server(route().build());
    http.onProtectedRequest((ctx, config) -> "vip".equals(ctx.adapter().getHeader("X-Tier"))
        ? ProtectedRequestHook.Result.grantAccess()
        : "blocked".equals(ctx.adapter().getHeader("X-Tier"))
            ? ProtectedRequestHook.Result.abort("blocked tier")
            : ProtectedRequestHook.Result.proceed());
    assertThat(http.processHttpRequest(TestAdapter.get("/weather").header("X-Tier", "vip")
        .context())).isInstanceOf(HttpProcessResult.NoPaymentRequired.class);
    HttpProcessResult.PaymentError abort = error(http.processHttpRequest(
        TestAdapter.get("/weather").header("X-Tier", "blocked").context()));
    assertThat(abort.status()).isEqualTo(403);
    assertThat(abort.headers()).containsExactly(Map.entry("Content-Type", "application/json"));
    assertThat(abort.body()).isEqualTo(Map.of("error", "blocked tier"));
    assertThat(error(http.processHttpRequest(TestAdapter.get("/weather").context())).status())
        .isEqualTo(402);
  }

  @Test
  void aMalformedSignatureIsTreatedAsUnpaid() {
    X402HttpResourceServer http = server(route().build());
    HttpProcessResult.PaymentError e = error(http.processHttpRequest(TestAdapter.get("/weather")
        .header("PAYMENT-SIGNATURE", "%%%not-base64").context()));
    assertThat(e.status()).isEqualTo(402);
    assertThat(paymentRequired(e).error()).isEqualTo("Payment required");
  }

  @Test
  void aValidPaymentIsVerified() {
    X402HttpResourceServer http = server(route().extensions(map("bazaar", map("x", 1))).build());
    PaymentPayload payload = pay(http, "/weather", 0);
    HttpProcessResult.PaymentVerified v = verified(http.processHttpRequest(
        TestAdapter.get("/weather").paying(payload).context()));
    assertThat(v.paymentPayload()).isEqualTo(payload);
    assertThat(v.paymentRequirements()).isEqualTo(payload.accepted());
    assertThat(v.declaredExtensions()).containsKey("bazaar");
    assertThat(v.beforeHandlerSettlement()).isNull();
    assertThat(v.cancellationDispatcher()).isNotNull();
    assertThat(v.verifiedBy()).isEqualTo("f");
    assertThat(v.routeKey()).isEqualTo("GET /weather");
    assertThat(f.verifyCalls).hasValue(1);
  }

  @Test
  void noMatchingRequirementsOrAnInvalidPaymentGive402WithTheReason() {
    X402HttpResourceServer http = server(route().build());
    PaymentPayload payload = pay(http, "/weather", 0);
    PaymentPayload tampered = new PaymentPayload(2, null, payload.accepted().withAmount("1"),
        payload.payload(), null);
    HttpProcessResult.PaymentError noMatch = error(http.processHttpRequest(
        TestAdapter.get("/weather").paying(tampered).context()));
    assertThat(noMatch.status()).isEqualTo(402);
    assertThat(noMatch.headers()).containsEntry("Content-Type", "application/json");
    assertThat(paymentRequired(noMatch).error()).isEqualTo("No matching payment requirements");

    f.thenVerify((p, r) -> VerifyResponse.invalid("insufficient_funds", "low"));
    HttpProcessResult.PaymentError invalid = error(http.processHttpRequest(
        TestAdapter.get("/weather").paying(payload).browser().context()));
    assertThat(invalid.status()).isEqualTo(402);
    assertThat(invalid.html()).isFalse();
    assertThat(paymentRequired(invalid).error()).isEqualTo("insufficient_funds");
  }

  @Test
  void anExtensionEchoMismatchGives402() {
    X402HttpResourceServer http = server(route()
        .extensions(map("builder-code", map("info", map("a", "app")))).build());
    PaymentPayload payload = pay(http, "/weather", 0);
    PaymentPayload forged = new PaymentPayload(2, null, payload.accepted(), payload.payload(),
        map("builder-code", map("info", map("a", "forged"))));
    assertThat(paymentRequired(http.processHttpRequest(TestAdapter.get("/weather")
        .paying(forged).context())).error()).isEqualTo("extension_echo_mismatch");
  }

  @Test
  void verifyErrorsBecome402ButFacilitatorTransportErrorsPropagate() {
    X402HttpResourceServer http = server(route().build());
    PaymentPayload payload = pay(http, "/weather", 0);
    f.thenVerify((p, r) -> {
      throw new IllegalStateException("Facilitator verify failed (500): boom");
    });
    assertThat(paymentRequired(http.processHttpRequest(TestAdapter.get("/weather")
        .paying(payload).context())).error())
        .isEqualTo("Facilitator verify failed (500): boom");

    f.thenVerify((p, r) -> {
      throw new FacilitatorResponseException.Timeout("verify", 15000);
    });
    assertThatThrownBy(() -> http.processHttpRequest(TestAdapter.get("/weather")
        .paying(payload).context())).isInstanceOf(FacilitatorResponseException.class);
  }

  @Test
  void permit2AllowanceErrorsAnswer412() {
    X402HttpResourceServer http = server(route().build());
    PaymentPayload payload = pay(http, "/weather", 0);
    f.thenVerify((p, r) -> VerifyResponse.invalid("permit2_allowance_required", null));
    assertThat(error(http.processHttpRequest(TestAdapter.get("/weather").paying(payload)
        .context())).status()).isEqualTo(412);
  }

  @Test
  void skipHandlerSettlesInlineAndAnswers200() {
    core.onAfterVerify(ctx -> AfterVerifyResult.skipHandler(
        new SkipHandlerDirective("text/plain", "refunded")));
    X402HttpResourceServer http = server(route().build());
    PaymentPayload payload = pay(http, "/weather", 0);
    HttpProcessResult.PaymentError done = error(http.processHttpRequest(
        TestAdapter.get("/weather").paying(payload).context()));
    assertThat(done.status()).isEqualTo(200);
    assertThat(done.body()).isEqualTo("refunded");
    assertThat(done.headers()).containsEntry("Content-Type", "text/plain")
        .containsEntry("Cache-Control", "private").containsKey("PAYMENT-RESPONSE");
    assertThat(f.settleCalls).hasValue(1);
  }

  @Test
  void skipHandlerWithAFailedSettleAnswersTheSettlementFailure() {
    core.onAfterVerify(ctx -> AfterVerifyResult.skipHandler(null));
    f.thenSettle((p, r) -> org.x402.core.types.SettleResponse.failure("nope", null, "", PREPROD));
    X402HttpResourceServer http = server(route().build());
    PaymentPayload payload = pay(http, "/weather", 0);
    HttpProcessResult.PaymentError failed = error(http.processHttpRequest(
        TestAdapter.get("/weather").paying(payload).context()));
    assertThat(failed.status()).isEqualTo(402);
    assertThat(HeaderCodec.decodePaymentResponse(failed.headers().get("PAYMENT-RESPONSE"))
        .errorReason()).isEqualTo("nope");
  }

  @Test
  void upfrontFlowsSettleBeforeTheHandler() {
    FakeServerScheme upfront = new FakeServerScheme();
    upfront.flows.put("default", new PaymentFlow.Config(List.of(PaymentFlow.UPFRONT),
        PaymentFlow.UPFRONT));
    X402ResourceServer upfrontCore = core(upfront, f);
    X402HttpResourceServer http = http(upfrontCore, routes("/u", route().build()));
    http.initialize();
    PaymentPayload payload = pay(http, "/u", 0);
    assertThat(payload.accepted().extra()).containsEntry("paymentFlow", "upfront");
    HttpProcessResult.PaymentVerified v = verified(http.processHttpRequest(
        TestAdapter.get("/u").paying(payload).context()));
    assertThat(f.verifyCalls).hasValue(0);
    assertThat(f.settleCalls).hasValue(1);
    assertThat(v.beforeHandlerSettlement().flow()).isEqualTo(PaymentFlow.UPFRONT);
    assertThat(v.beforeHandlerSettlement().result().success()).isTrue();

    f.thenSettle((p, r) -> org.x402.core.types.SettleResponse.failure("no_funds", null, "",
        PREPROD));
    HttpProcessResult.PaymentError failed = error(http.processHttpRequest(
        TestAdapter.get("/u").paying(payload).context()));
    assertThat(failed.status()).isEqualTo(402);
  }

  @Test
  void dynamicPriceAndPayToResolvePerRequestAndDecodedPathsMatch() {
    RouteConfig dynamic = RouteConfig.builder().accepts(List.of(PaymentOption.builder()
        .scheme("exact").network(PREPROD)
        .payTo(ctx -> "addr_" + ctx.adapter().getHeader("X-Seller"))
        .price(ctx -> ctx.adapter().getHeader("X-Big") != null
            ? new AssetAmount("lovelace", "5", null) : new Money("$0.02"))
        .maxTimeoutSeconds(60).extra(map("k", "v")).build())).build();
    X402HttpResourceServer http = http(core, routes("/items/:id", dynamic));
    http.initialize();
    PaymentRequired cheap = paymentRequired(http.processHttpRequest(TestAdapter.get("/items/1")
        .header("X-Seller", "s1").context()));
    assertThat(cheap.accepts().get(0).payTo()).isEqualTo("addr_s1");
    assertThat(cheap.accepts().get(0).amount()).isEqualTo("20000");
    assertThat(cheap.accepts().get(0).maxTimeoutSeconds()).isEqualTo(60);
    assertThat(cheap.accepts().get(0).extra()).containsEntry("k", "v");
    PaymentRequired big = paymentRequired(http.processHttpRequest(TestAdapter.get("/items/1")
        .header("X-Seller", "s2").header("X-Big", "1").context()));
    assertThat(big.accepts().get(0).asset()).isEqualTo("lovelace");

    HttpRequestContext encoded = TestAdapter.get("/items/a%2Fb/x").context()
        .withPaths("/items/a%2Fb/x", "/items/ab");
    assertThat(http.processHttpRequest(encoded))
        .isInstanceOf(HttpProcessResult.PaymentError.class);
  }

  @Test
  void extensionsAreEnrichedPerRequestAndMayHookProtectedRequests() {
    core.registerExtension(new HttpResourceServerExtension() {
      @Override
      public String key() {
        return "bazaar";
      }

      @Override
      public Object enrichDeclaration(Object declaration, Object transportContext) {
        return map("method", ((HttpRequestContext) transportContext).method());
      }

      @Override
      public ProtectedRequestHook.Result onProtectedRequest(Object declaration,
          HttpRequestContext context, RouteConfig config) {
        return "free".equals(context.adapter().getHeader("X-Pass"))
            ? ProtectedRequestHook.Result.grantAccess() : ProtectedRequestHook.Result.proceed();
      }
    });
    X402HttpResourceServer http = server(route().extensions(map("bazaar", map())).build());
    assertThat(paymentRequired(http.processHttpRequest(TestAdapter.get("/weather").context()))
        .extensions()).containsEntry("bazaar", map("method", "GET"));
    assertThat(http.processHttpRequest(TestAdapter.get("/weather").header("X-Pass", "free")
        .context())).isInstanceOf(HttpProcessResult.NoPaymentRequired.class);
  }

  @Test
  void processingBeforeInitializeIsRejected() {
    X402HttpResourceServer http = http(core, routes("/x", route().build()));
    assertThatThrownBy(() -> http.processHttpRequest(TestAdapter.get("/x").context()))
        .isInstanceOf(IllegalStateException.class).hasMessageContaining("initialize()");
    assertThat(http.processHttpRequest(TestAdapter.get("/other").context()))
        .isInstanceOf(HttpProcessResult.NoPaymentRequired.class);
  }
}
