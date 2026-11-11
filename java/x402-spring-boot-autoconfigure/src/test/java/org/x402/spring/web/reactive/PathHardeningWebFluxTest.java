package org.x402.spring.web.reactive;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.x402.spring.FakeFacilitator;
import org.x402.spring.HookRecorder;
import org.x402.spring.X402StarterContract;
import org.x402.spring.web.PathHardeningControllers;
import org.x402.spring.web.RawHttp;

/**
 * WebFlux: every form of a path that may reach the paid handler is charged (never served free),
 * and a path whose forms select the cheap and the paid offer is refused with 400. Requests go
 * over a raw socket, so dot segments and matrix parameters arrive as written.
 */
class PathHardeningWebFluxTest {

  private static FakeFacilitator facilitator;
  private static ConfigurableApplicationContext vaultOnly;
  private static ConfigurableApplicationContext vaultAndCheap;

  private static ConfigurableApplicationContext start(Map<String, Object> overrides) {
    Map<String, Object> props = new LinkedHashMap<>(X402StarterContract.contractProperties());
    props.put("x402.facilitators[0].url", facilitator.url());
    props.put("server.port", "0");
    props.put("spring.main.web-application-type", "reactive");
    props.putAll(overrides);
    return new SpringApplicationBuilder(X402PaymentWebFluxTest.FluxApp.class,
        PathHardeningControllers.class).properties(props).run();
  }

  @BeforeAll
  static void startApps() {
    facilitator = FakeFacilitator.start(HookRecorder.NET, HookRecorder.MAIN);
    vaultOnly = start(PathHardeningControllers.offers("GET /vault", null));
    vaultAndCheap = start(PathHardeningControllers.offers("GET /vault", "GET /cheap/*"));
  }

  @AfterAll
  static void stopApps() {
    vaultOnly.close();
    vaultAndCheap.close();
    facilitator.close();
  }

  private static int port(ConfigurableApplicationContext ctx) {
    return Integer.parseInt(ctx.getEnvironment().getProperty("local.server.port"));
  }

  @ParameterizedTest
  @ValueSource(strings = {"/public/..;/vault", "/public/%2e%2e/vault", "/public/../vault",
      "//vault", "/vault/", "/Vault", "/vault;a=b"})
  void everyFormOfThePaidPathIsChargedNeverServedFree(String path) {
    int status = RawHttp.status(port(vaultOnly), "GET", path);
    assertThat(status).as(path).isNotEqualTo(200).isEqualTo(402);
  }

  @ParameterizedTest
  @ValueSource(strings = {"/cheap/../vault", "/cheap/..;/vault", "/cheap/%2e%2e/vault"})
  void formsThatSelectTheCheapAndThePaidOfferAreRefused(String path) {
    assertThat(RawHttp.status(port(vaultAndCheap), "GET", path)).as(path).isEqualTo(400);
  }

  @ParameterizedTest
  @ValueSource(strings = {"/cheap/x", "/vault"})
  void eachOfferStillAnswersItsOwn402(String path) {
    assertThat(RawHttp.status(port(vaultAndCheap), "GET", path)).as(path).isEqualTo(402);
  }

  @Test
  void aBasePathIsStrippedBeforeMatching() {
    Map<String, Object> props = new LinkedHashMap<>(
        PathHardeningControllers.offers("GET /vault", null));
    props.put("spring.webflux.base-path", "/api");
    try (ConfigurableApplicationContext ctx = start(props)) {
      assertThat(RawHttp.status(port(ctx), "GET", "/api/vault")).isEqualTo(402);
      assertThat(RawHttp.status(port(ctx), "GET", "/api/public/..;/vault")).isEqualTo(402);
    }
  }
}
