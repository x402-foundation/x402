package org.x402.spring.web.servlet;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.x402.http.X402Headers;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402StarterContract;
import org.x402.spring.offer.OfferRegistry;
import org.x402.spring.web.PathHardeningControllers;
import org.x402.spring.web.RawHttp;

/**
 * With {@code spring.mvc.servlet.path=/api}, YAML {@code path:} offers are matched in the
 * DispatcherServlet's own path space (closes the 2026-10-21 security-review finding: they used to
 * stop charging), whether written relative to the dispatcher or with the prefix, and a cheap
 * offer in one space cannot shadow a paid offer another form of the path selects.
 */
class ServletPathPrefixMvcTest {

  private static FakeFacilitator facilitator;

  @BeforeAll
  static void startFacilitator() {
    facilitator = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
  }

  @AfterAll
  static void stopFacilitator() {
    facilitator.close();
  }

  @BeforeEach
  void resetFacilitator() {
    facilitator.reset(HookRecorder.NET, HookRecorder.MAIN);
  }

  private static ConfigurableApplicationContext start(Map<String, Object> overrides) {
    Map<String, Object> props = new LinkedHashMap<>(X402StarterContract.contractProperties());
    props.put("x402.facilitators[0].url", facilitator.url());
    props.put("server.port", "0");
    props.put("spring.main.web-application-type", "servlet");
    props.put("spring.mvc.servlet.path", "/api");
    props.putAll(overrides);
    return new SpringApplicationBuilder(X402PaymentMvcTest.MvcApp.class,
        PathHardeningControllers.class).properties(props).run();
  }

  private static int port(ConfigurableApplicationContext ctx) {
    return Integer.parseInt(ctx.getEnvironment().getProperty("local.server.port"));
  }

  private static String url(ConfigurableApplicationContext ctx, String path) {
    return "http://127.0.0.1:" + port(ctx) + path;
  }

  private static boolean warnsNoHandler(ConfigurableApplicationContext ctx, String offer) {
    return ctx.getBean(OfferRegistry.class).warnings().stream()
        .anyMatch(w -> w.contains("\"" + offer + "\"") && w.contains("matches no registered"));
  }

  @Test
  void anOfferWrittenRelativeToTheDispatcherIsChargedAndSettledOnce() {
    try (ConfigurableApplicationContext ctx = start(Map.of())) {
      HttpResponse<String> unpaid = TestHttp.get(url(ctx, "/api/report/q1"));
      assertThat(unpaid.statusCode()).isEqualTo(402);
      HttpResponse<String> paid = TestHttp.send("GET", url(ctx, "/api/report/q1"),
          X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, null));
      assertThat(paid.statusCode()).isEqualTo(200);
      assertThat(paid.body()).isEqualTo("report q1");
      assertThat(facilitator.count("settle")).isEqualTo(1);
      assertThat(warnsNoHandler(ctx, "report")).isFalse();
    }
  }

  @Test
  void anOfferWrittenWithThePrefixIsChargedWithoutAWarning() {
    try (ConfigurableApplicationContext ctx = start(
        Map.of("x402.routes.report.path", "GET /api/report/*"))) {
      assertThat(TestHttp.get(url(ctx, "/api/report/q1")).statusCode()).isEqualTo(402);
      assertThat(warnsNoHandler(ctx, "report")).isFalse();
    }
  }

  @Test
  void anAnnotatedHandlerIsStillChargedUnderTheServletPath() {
    try (ConfigurableApplicationContext ctx = start(Map.of())) {
      assertThat(TestHttp.get(url(ctx, "/api/weather")).statusCode()).isEqualTo(402);
    }
  }

  @Test
  void dotSegmentsTheDispatcherResolvesToThePaidHandlerAreCharged() {
    Map<String, Object> props = new LinkedHashMap<>(
        PathHardeningControllers.offers("GET /vault", null));
    props.put("spring.mvc.pathmatch.matching-strategy", "ant_path_matcher");
    try (ConfigurableApplicationContext ctx = start(props)) {
      assertThat(RawHttp.status(port(ctx), "GET", "/api/public/..;/vault")).isEqualTo(402);
      assertThat(RawHttp.status(port(ctx), "GET", "/api/public/%2e%2e/vault")).isNotEqualTo(200);
    }
  }

  @Test
  void aCheapDispatcherOfferCannotShadowAPaidOfferWrittenWithThePrefix() {
    Map<String, Object> props = new LinkedHashMap<>(
        PathHardeningControllers.offers("GET /api/vault", "GET /cheap/*"));
    props.put("spring.mvc.pathmatch.matching-strategy", "ant_path_matcher");
    try (ConfigurableApplicationContext ctx = start(props)) {
      assertThat(RawHttp.status(port(ctx), "GET", "/api/cheap/..;/vault")).isEqualTo(400);
      assertThat(RawHttp.status(port(ctx), "GET", "/api/cheap/../vault")).isEqualTo(400);
      assertThat(TestHttp.get(url(ctx, "/api/cheap/x")).statusCode()).isEqualTo(402);
      assertThat(TestHttp.get(url(ctx, "/api/vault")).statusCode()).isEqualTo(402);
    }
  }
}
