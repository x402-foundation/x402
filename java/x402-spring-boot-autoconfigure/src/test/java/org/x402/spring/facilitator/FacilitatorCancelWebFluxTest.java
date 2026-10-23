package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.netty.NettyReactiveWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.http.client.ReactorResourceFactory;
import org.x402.core.FacilitatorContext;
import org.x402.core.SchemeNetworkFacilitator;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.spring.TestHttp;

/**
 * A settle that started on the WebFlux facilitator endpoint completes
 * when the client goes away (no interrupted worker mid-broadcast).
 */
@SpringBootTest(classes = FacilitatorCancelWebFluxTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = {"spring.main.web-application-type=reactive",
        "x402.facilitator-server.enabled=true"})
class FacilitatorCancelWebFluxTest {

  static final List<String> OUTCOMES = new CopyOnWriteArrayList<>();

  @LocalServerPort
  int port;

  /** Settles after one second; records whether it was interrupted. */
  static final class SlowScheme implements SchemeNetworkFacilitator {
    @Override
    public String scheme() {
      return "exact";
    }

    @Override
    public String caipFamily() {
      return "test:*";
    }

    @Override
    public Map<String, Object> getExtra(String network) {
      return Map.of();
    }

    @Override
    public List<String> getSigners(String network) {
      return List.of();
    }

    @Override
    public VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements,
        FacilitatorContext context) {
      return VerifyResponse.valid("p");
    }

    @Override
    public SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements,
        FacilitatorContext context) {
      try {
        Thread.sleep(1000);
        OUTCOMES.add("completed");
        return SettleResponse.success("tx-slow", requirements.network(), "p");
      } catch (InterruptedException e) {
        OUTCOMES.add("interrupted");
        Thread.currentThread().interrupt();
        return SettleResponse.failure("interrupted", "interrupted", "", requirements.network());
      }
    }
  }

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
    X402FacilitatorCustomizer slowScheme() {
      return facilitator -> facilitator.register("test:net", new SlowScheme());
    }
  }

  @Test
  void aStartedSettleCompletesWhenTheClientGoesAway() throws Exception {
    HttpRequest request = HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + "/x402/settle"))
        .timeout(Duration.ofMillis(300)).header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(FacilitatorWire.body(null))).build();
    try {
      HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    } catch (HttpTimeoutException expected) {
      // the client gave up mid-settle
    }
    TestHttp.await(Duration.ofSeconds(5), () -> !OUTCOMES.isEmpty());
    Thread.sleep(200);
    assertThat(OUTCOMES).containsExactly("completed");
  }
}
