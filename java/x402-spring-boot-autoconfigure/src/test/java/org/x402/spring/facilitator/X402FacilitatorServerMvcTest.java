package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.core.hooks.HookResults;
import org.x402.core.json.X402Json;
import org.x402.core.server.X402ResourceServer;
import org.x402.http.facilitator.FacilitatorHttpHandler;
import org.x402.http.facilitator.FacilitatorHttpResponse;
import org.x402.http.facilitator.LocalFacilitatorClient;
import org.x402.mechanisms.cardano.exact.facilitator.CardanoFacilitatorSigner;
import org.x402.spring.TestHttp;
import org.x402.spring.X402ServerLifecycle;

/** The facilitator server on WebMvc answers the normative wire table. */
@SpringBootTest(classes = X402FacilitatorServerMvcTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "spring.main.web-application-type=servlet",
        "x402.facilitator-server.enabled=true",
        "x402.facilitator-server.cardano.networks[0].network=cardano:preprod",
        "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=preprodKey",
        "x402.facilitator-server.cardano.networks[0].mnemonic=" + FacilitatorWire.MNEMONIC})
class X402FacilitatorServerMvcTest {

  static final AtomicInteger AFTER_VERIFY = new AtomicInteger();

  @LocalServerPort
  int port;

  @Autowired
  ConfigurableApplicationContext context;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {
    @Bean
    X402FacilitatorCustomizer fakeScheme() {
      return facilitator -> facilitator.register("test:net", new FakeFacilitatorScheme("fake"))
          .onAfterVerify(ctx -> AFTER_VERIFY.incrementAndGet())
          .onBeforeSettle(ctx -> "abort".equals(ctx.paymentPayload().payload().get("mode"))
              ? HookResults.Decision.abort("payee_not_allowed")
              : HookResults.Decision.proceed());
    }
  }

  /** Serves the handler from an own controller (expose-http=false). */
  @RestController
  static class OwnEndpoints {
    private final FacilitatorHttpHandler handler;

    OwnEndpoints(FacilitatorHttpHandler handler) {
      this.handler = handler;
    }

    @RequestMapping("/x402/{endpoint}")
    ResponseEntity<String> handle(@PathVariable("endpoint") String endpoint,
        @RequestBody(required = false) byte[] body,
        jakarta.servlet.http.HttpServletRequest request) {
      FacilitatorHttpResponse response = handler.handle(request.getMethod(),
          "/x402/" + endpoint, body == null ? new byte[0] : body);
      return ResponseEntity.status(response.status())
          .header("Content-Type", FacilitatorHttpResponse.CONTENT_TYPE).body(response.body());
    }
  }

  private String url(String path) {
    return "http://127.0.0.1:" + port + path;
  }

  private static String variantUrl(ConfigurableApplicationContext ctx, String path) {
    return "http://127.0.0.1:" + ctx.getEnvironment().getProperty("local.server.port") + path;
  }

  private static ConfigurableApplicationContext variant(String... properties) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("server.port", "0");
    p.put("spring.main.web-application-type", "servlet");
    p.put("x402.facilitator-server.enabled", "true");
    p.put("x402.facilitator-server.cardano.networks[0].network", "cardano:preprod");
    p.put("x402.facilitator-server.cardano.networks[0].blockfrost.project-id", "k");
    for (int i = 0; i < properties.length; i += 2) {
      p.put(properties[i], properties[i + 1]);
    }
    return new SpringApplicationBuilder(App.class).properties(p).run();
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> json(HttpResponse<String> response) {
    return X402Json.read(response.body(), Map.class);
  }

  @Test
  void supportedListsEveryKindWithTheCardanoRangeAndSigner() {
    HttpResponse<String> response = TestHttp.get(url("/x402/supported"));

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.headers().firstValue("Content-Type").orElse(""))
        .startsWith("application/json");
    String body = response.body();
    assertThat(body).contains("\"network\":\"test:net\"").contains("\"marker\":\"fake\"")
        .contains("\"network\":\"cardano:preprod\"")
        .contains("\"l1Confirmations\":{\"minimum\":0,\"maximum\":20}")
        .contains(CardanoFacilitatorSigner.fromMnemonic(FacilitatorWire.MNEMONIC,
            "cardano:preprod").getAddresses().get(0));
  }

  @Test
  void verifyAndSettleAnswerTheWireTable() {
    int before = AFTER_VERIFY.get();
    HttpResponse<String> valid = TestHttp.sendBody("POST", url("/x402/verify"),
        "application/json", FacilitatorWire.body(null));
    assertThat(valid.statusCode()).isEqualTo(200);
    assertThat(json(valid)).containsEntry("isValid", true);
    assertThat(AFTER_VERIFY.get()).isEqualTo(before + 1);

    HttpResponse<String> invalid = TestHttp.sendBody("POST", url("/x402/verify"),
        "application/json", FacilitatorWire.body("invalid"));
    assertThat(invalid.statusCode()).isEqualTo(200);
    assertThat(json(invalid)).containsEntry("isValid", false)
        .containsEntry("invalidReason", "invalid_payload");

    HttpResponse<String> settled = TestHttp.sendBody("POST", url("/x402/settle"),
        "application/json", FacilitatorWire.body(null));
    assertThat(settled.statusCode()).isEqualTo(200);
    assertThat(json(settled)).containsEntry("success", true)
        .containsEntry("transaction", "tx-fake");

    HttpResponse<String> aborted = TestHttp.sendBody("POST", url("/x402/settle"),
        "application/json", FacilitatorWire.body("abort"));
    assertThat(aborted.statusCode()).isEqualTo(200);
    assertThat(json(aborted)).containsEntry("success", false)
        .containsEntry("errorReason", "payee_not_allowed").containsEntry("transaction", "")
        .containsEntry("network", "test:net");

    assertThat(TestHttp.sendBody("POST", url("/x402/verify"), "application/json",
        FacilitatorWire.missingRequirements()).statusCode()).isEqualTo(400);
    assertThat(TestHttp.get(url("/x402/verify")).statusCode()).isEqualTo(405);
  }

  @Test
  void aFacilitatorOnlyAppSkipsTheResourceServerSync() {
    assertThat(context.getBean(X402ServerLifecycle.class).synced()).isFalse();
  }

  @Test
  void theRootBasePathServesTheEndpointsAtTheRoot() {
    for (String base : new String[] {"", "/"}) {
      try (ConfigurableApplicationContext ctx = variant(
          "x402.facilitator-server.base-path", base)) {
        assertThat(TestHttp.get(variantUrl(ctx, "/supported")).statusCode()).isEqualTo(200);
        assertThat(TestHttp.get(variantUrl(ctx, "/x402/supported")).statusCode())
            .isEqualTo(404);
      }
    }
  }

  @Test
  void exposeHttpFalseServesNothingButStillProvidesTheLocalClient() {
    try (ConfigurableApplicationContext ctx = variant(
        "x402.facilitator-server.expose-http", "false", "x402.local-facilitator", "true")) {
      assertThat(TestHttp.get(variantUrl(ctx, "/x402/supported")).statusCode()).isEqualTo(404);
      assertThat(ctx.getBean(LocalFacilitatorClient.class)).isNotNull();
      assertThat(ctx.getBean(X402ResourceServer.class).facilitatorIdentifiers())
          .startsWith("local");
    }
    try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(App.class,
        OwnEndpoints.class).properties("server.port=0",
            "spring.main.web-application-type=servlet",
            "x402.facilitator-server.enabled=true",
            "x402.facilitator-server.expose-http=false").run()) {
      HttpResponse<String> own = TestHttp.sendBody("POST", variantUrl(ctx, "/x402/verify"),
          "application/json", FacilitatorWire.body(null));
      assertThat(own.statusCode()).isEqualTo(200);
      assertThat(json(own)).containsEntry("isValid", true);
    }
  }

  @Test
  void providerOnlyAndAcceptMempoolChangeWhatIsAdvertised() {
    try (ConfigurableApplicationContext ctx = variant(
        "x402.facilitator-server.cardano.accept-mempool", "true")) {
      String body = TestHttp.get(variantUrl(ctx, "/x402/supported")).body();
      assertThat(body).contains("\"l1Confirmations\":{\"minimum\":-1,\"maximum\":20}");
      assertThat(body).doesNotContain("addr_test");
    }
  }

  @Test
  void twoNetworkEntriesGiveTwoKindsWithTheirOwnBackends() {
    try (ConfigurableApplicationContext ctx = variant(
        "x402.facilitator-server.cardano.networks[1].network", "cardano:mainnet",
        "x402.facilitator-server.cardano.networks[1].blockfrost.project-id", "mainnetKey")) {
      String body = TestHttp.get(variantUrl(ctx, "/x402/supported")).body();
      assertThat(body).contains("cardano:preprod").contains("cardano:mainnet");
      CardanoFacilitatorSchemes schemes = ctx.getBean(CardanoFacilitatorSchemes.class);
      assertThat(schemes.networks()).containsExactly("cardano:preprod", "cardano:mainnet");
      assertThat(schemes.backend("cardano:preprod"))
          .isNotSameAs(schemes.backend("cardano:mainnet"));
    }
  }
}
