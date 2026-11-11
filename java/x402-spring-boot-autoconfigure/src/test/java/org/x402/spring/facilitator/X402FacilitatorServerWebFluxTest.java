package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpResponse;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.netty.NettyReactiveWebServerFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.http.client.ReactorResourceFactory;
import org.x402.core.hooks.HookResults;
import org.x402.core.json.X402Json;
import org.x402.spring.TestHttp;
import reactor.blockhound.BlockHound;

/** The facilitator server on WebFlux (Reactor Netty, BlockHound) answers the wire table. */
@SpringBootTest(classes = X402FacilitatorServerWebFluxTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {
        "spring.main.web-application-type=reactive",
        "x402.facilitator-server.enabled=true",
        "x402.facilitator-server.cardano.networks[0].network=cardano:preprod",
        "x402.facilitator-server.cardano.networks[0].blockfrost.project-id=preprodKey"})
class X402FacilitatorServerWebFluxTest {

  static {
    BlockHound.install();
  }

  @LocalServerPort
  int port;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {
    @Bean
    ReactorResourceFactory reactorResourceFactory() {
      ReactorResourceFactory resources = new ReactorResourceFactory();
      resources.setUseGlobalResources(false);
      return resources;
    }

    @Bean
    NettyReactiveWebServerFactory nettyReactiveWebServerFactory(ReactorResourceFactory resources)
        throws Exception {
      NettyReactiveWebServerFactory factory = new NettyReactiveWebServerFactory();
      factory.setResourceFactory(resources);
      factory.setAddress(java.net.InetAddress.getByName("::"));
      return factory;
    }

    @Bean
    X402FacilitatorCustomizer fakeScheme() {
      return facilitator -> facilitator.register("test:net", new FakeFacilitatorScheme("flux"))
          .onBeforeSettle(ctx -> "abort".equals(ctx.paymentPayload().payload().get("mode"))
              ? HookResults.Decision.abort("payee_not_allowed")
              : HookResults.Decision.proceed());
    }
  }

  private String url(String path) {
    return "http://127.0.0.1:" + port + path;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> json(HttpResponse<String> response) {
    return X402Json.read(response.body(), Map.class);
  }

  @Test
  void theEndpointsAnswerTheWireTableWithoutBlockingTheEventLoop() {
    HttpResponse<String> supported = TestHttp.get(url("/x402/supported"));
    assertThat(supported.statusCode()).isEqualTo(200);
    assertThat(supported.body()).contains("\"marker\":\"flux\"").contains("cardano:preprod")
        .contains("\"l1Confirmations\":{\"minimum\":0,\"maximum\":20}");

    HttpResponse<String> valid = TestHttp.sendBody("POST", url("/x402/verify"),
        "application/json", FacilitatorWire.body(null));
    assertThat(valid.statusCode()).isEqualTo(200);
    assertThat(json(valid)).containsEntry("isValid", true);

    HttpResponse<String> aborted = TestHttp.sendBody("POST", url("/x402/settle"),
        "application/json", FacilitatorWire.body("abort"));
    assertThat(aborted.statusCode()).isEqualTo(200);
    assertThat(json(aborted)).containsEntry("success", false)
        .containsEntry("errorReason", "payee_not_allowed");

    assertThat(TestHttp.sendBody("POST", url("/x402/settle"), "application/json",
        FacilitatorWire.missingRequirements()).statusCode()).isEqualTo(400);
    assertThat(TestHttp.get(url("/x402/settle")).statusCode()).isEqualTo(405);
    assertThat(TestHttp.get(url("/other")).statusCode()).isEqualTo(404);
  }

  @Test
  void theRootBasePathWorksOnWebFluxToo() {
    try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(App.class).properties(
        "server.port=0", "spring.main.web-application-type=reactive",
        "x402.facilitator-server.enabled=true", "x402.facilitator-server.base-path=").run()) {
      String base = "http://127.0.0.1:" + ctx.getEnvironment().getProperty("local.server.port");
      assertThat(TestHttp.get(base + "/supported").statusCode()).isEqualTo(200);
      assertThat(TestHttp.sendBody("POST", base + "/verify", "application/json",
          FacilitatorWire.body(null)).statusCode()).isEqualTo(200);
    }
  }
}
