package org.x402.spring.autoconfigure;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.x402.http.RouteConfigurationError;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.annotation.X402Payment;

/** Startup sync: the four cases, health, and single-flight re-sync. */
@ExtendWith(OutputCaptureExtension.class)
class StartupSyncTest {

  private static FakeFacilitator a;
  private static FakeFacilitator b;
  private ConfigurableApplicationContext context;

  @RestController
  static class SyncController {
    @X402Payment("a")
    @GetMapping("/a")
    String a() {
      return "a";
    }

    @X402Payment("b")
    @GetMapping("/b")
    String b() {
      return "b";
    }

    @GetMapping("/free")
    String free() {
      return "free";
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import(SyncController.class)
  static class SyncApp {
    @Bean
    HookRecorder hookRecorder() {
      return new HookRecorder();
    }
  }

  /** The same app without annotated handlers (an app with no offers at all). */
  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class NoOffersApp {
    @Bean
    HookRecorder hookRecorder() {
      return new HookRecorder();
    }
  }

  @BeforeAll
  static void startFacilitators() {
    a = FakeFacilitator.start(HookRecorder.NET);
    b = FakeFacilitator.start(HookRecorder.MAIN);
  }

  @AfterAll
  static void stopFacilitators() {
    a.close();
    b.close();
  }

  @BeforeEach
  void reset() {
    a.reset(HookRecorder.NET);
    b.reset(HookRecorder.MAIN);
  }

  @AfterEach
  void close() {
    if (context != null) {
      context.close();
    }
  }

  private static Map<String, Object> props(String... extra) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("server.port", "0");
    p.put("spring.main.web-application-type", "servlet");
    p.put("management.endpoints.web.exposure.include", "health");
    p.put("management.endpoint.health.show-details", "always");
    p.put("x402.facilitators[0].url", a.url());
    p.put("x402.facilitators[0].identifier", "a");
    p.put("x402.facilitators[1].url", b.url());
    p.put("x402.facilitators[1].identifier", "b");
    p.put("x402.sync.startup-timeout", "3s");
    p.put("x402.sync.initial-backoff", "100ms");
    p.put("x402.sync.max-backoff", "200ms");
    p.put("x402.accounts.net.network", "test:net");
    p.put("x402.accounts.net.pay-to", "addr_net");
    p.put("x402.accounts.main.network", "test:main");
    p.put("x402.accounts.main.pay-to", "addr_main");
    p.put("x402.routes.a.accepts[0].account", "net");
    p.put("x402.routes.a.accepts[0].price", "$0.01");
    p.put("x402.routes.b.accepts[0].account", "main");
    p.put("x402.routes.b.accepts[0].price", "$0.02");
    for (int i = 0; i < extra.length; i += 2) {
      p.put(extra[i], extra[i + 1]);
    }
    return p;
  }

  private ConfigurableApplicationContext start(Map<String, Object> properties) {
    context = new SpringApplicationBuilder(SyncApp.class).properties(properties).run();
    return context;
  }

  private String url(String path) {
    return "http://127.0.0.1:" + context.getEnvironment().getProperty("local.server.port") + path;
  }

  private String health() {
    return TestHttp.get(url("/actuator/health/x402")).body();
  }

  @Test
  void allFacilitatorsAnsweredAndValidationFailsStopsStartup() {
    b.supported(HookRecorder.NET);
    assertThatThrownBy(() -> start(props()))
        .hasRootCauseInstanceOf(RouteConfigurationError.class)
        .rootCause().hasMessageContaining("offer \"b\"");
  }

  @Test
  void partialFailureStartsWithAffectedRoutesAt503UntilTheResyncHeals() {
    b.supportedFails(503);
    start(props());

    HttpResponse<String> affected = TestHttp.get(url("/b"));
    assertThat(affected.statusCode()).isEqualTo(503);
    assertThat(affected.headers().firstValue("Retry-After")).isPresent();
    assertThat(TestHttp.get(url("/a")).statusCode()).isEqualTo(402);
    assertThat(TestHttp.get(url("/free")).statusCode()).isEqualTo(200);
    assertThat(health()).contains("OUT_OF_SERVICE");

    b.supported(HookRecorder.MAIN);
    TestHttp.await(Duration.ofSeconds(10), () -> TestHttp.get(url("/b")).statusCode() == 402);
    TestHttp.await(Duration.ofSeconds(5), () -> health().contains("\"status\":\"UP\""));
  }

  @Test
  void nonKindErrorsAreFatalEvenDuringAnOutage() {
    b.supportedFails(503);
    assertThatThrownBy(() -> start(props(
        "x402.routes.c.accepts[0].network", "test:net",
        "x402.routes.c.accepts[0].pay-to", "addr",
        "x402.routes.c.accepts[0].scheme", "nope",
        "x402.routes.c.accepts[0].price", "$1")))
        .hasRootCauseInstanceOf(RouteConfigurationError.class)
        .rootCause().hasMessageContaining("offer \"c\"");
  }

  @Test
  void aFailedButUnneededFacilitatorIsNotRetriedAndHealthStaysUp(CapturedOutput output)
      throws Exception {
    a.supported(HookRecorder.NET, HookRecorder.MAIN);
    b.supportedFails(503);
    start(props());

    assertThat(TestHttp.get(url("/b")).statusCode()).isEqualTo(402);
    Thread.sleep(600);
    assertThat(b.count("supported")).isEqualTo(1);
    HttpResponse<String> overall = TestHttp.get(url("/actuator/health"));
    assertThat(overall.statusCode()).isEqualTo(200);
    assertThat(overall.body()).startsWith("{\"status\":\"UP\"");
    assertThat(health()).contains("\"status\":\"UP\"").contains("\"b\"").contains("DOWN");
    assertThat(output.getOut() + output.getErr())
        .containsOnlyOnce("facilitator \"b\" failed at startup");
  }

  @Test
  void resyncThatStillFailsValidationAnswers500OnAffectedRoutesAndKeepsTrying(
      CapturedOutput output) {
    b.supportedFails(503);
    start(props());
    assertThat(TestHttp.get(url("/b")).statusCode()).isEqualTo(503);

    b.supported(HookRecorder.NET);
    TestHttp.await(Duration.ofSeconds(10), () -> TestHttp.get(url("/b")).statusCode() == 500);
    HttpResponse<String> broken = TestHttp.get(url("/b"));
    assertThat(broken.body()).contains("x402 route configuration");
    assertThat(TestHttp.get(url("/a")).statusCode()).isEqualTo(402);
    assertThat(health()).contains("\"status\":\"DOWN\"");
    int calls = b.count("supported");
    TestHttp.await(Duration.ofSeconds(5), () -> b.count("supported") > calls + 1);
    assertThat(output.getOut() + output.getErr())
        .containsOnlyOnce("x402 re-sync: route validation still fails");

    b.supported(HookRecorder.MAIN);
    TestHttp.await(Duration.ofSeconds(10), () -> TestHttp.get(url("/b")).statusCode() == 402);
  }

  @Test
  void noOffersSkipsTheSync() {
    Map<String, Object> p = props();
    p.keySet().removeIf(k -> k.startsWith("x402.routes"));
    context = new SpringApplicationBuilder(NoOffersApp.class).properties(p).run();
    assertThat(a.count("supported")).isZero();
    assertThat(b.count("supported")).isZero();
    assertThat(health()).contains("\"status\":\"UP\"");
  }

  @Test
  void concurrentRequestsDuringAnOutageGet503FastAndOneSyncIsInFlight() throws Exception {
    b.supportedFails(503);
    start(props("x402.sync.initial-backoff", "50ms", "x402.sync.max-backoff", "100ms"));
    b.supportedSlow(1500, 503);
    for (int i = 0; i < 20; i++) {
      TestHttp.get(url("/b"));
    }
    int beforeA = a.count("supported");
    int beforeB = b.count("supported");

    ExecutorService pool = Executors.newFixedThreadPool(50);
    try {
      CountDownLatch go = new CountDownLatch(1);
      List<Future<long[]>> calls = new ArrayList<>();
      for (int i = 0; i < 50; i++) {
        calls.add(pool.submit(() -> {
          go.await();
          long t0 = System.nanoTime();
          int status = TestHttp.get(url("/b")).statusCode();
          return new long[] {status, (System.nanoTime() - t0) / 1_000_000};
        }));
      }
      go.countDown();
      for (Future<long[]> call : calls) {
        long[] r = call.get();
        assertThat(r[0]).isEqualTo(503);
        assertThat(r[1]).isLessThan(100);
      }
    } finally {
      pool.shutdownNow();
    }
    assertThat(a.count("supported") - beforeA).isLessThanOrEqualTo(1);
    assertThat(b.count("supported") - beforeB).isLessThanOrEqualTo(1);
  }

  @Test
  void healthReportsEachFacilitatorInItsDetails() {
    start(props());
    assertThat(health()).contains("\"status\":\"UP\"").contains("\"a\"").contains("\"b\"");
  }
}
