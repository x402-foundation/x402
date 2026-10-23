package org.x402.spring.web.reactive;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.netty.NettyReactiveWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.http.client.ReactorResourceFactory;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.x402.core.hooks.HookResults;
import org.x402.http.X402Headers;
import org.x402.spring.ContractApp;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402ResourceServerCustomizer;
import org.x402.spring.X402StarterContract;

/**
 * A client that goes away while the offloaded {@code processHttpRequest} is still verifying: the
 * verified payment is not leaked, the {@code onVerifiedPaymentCanceled} hooks run.
 */
@SpringBootTest(classes = WebFluxCancelDuringVerifyTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=reactive")
class WebFluxCancelDuringVerifyTest {

  static final CountDownLatch ENTERED = new CountDownLatch(1);
  static final CountDownLatch RELEASE = new CountDownLatch(1);

  @DynamicPropertySource
  static void x402Properties(DynamicPropertyRegistry registry) {
    X402StarterContract.contractProperties().forEach((k, v) -> registry.add(k, () -> v));
  }

  @LocalServerPort
  int port;

  @Autowired
  HookRecorder recorder;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import(ContractApp.class)
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

    /** Holds the first verify until the test lets it go. */
    @Bean
    X402ResourceServerCustomizer blockingVerify() {
      return server -> server.onBeforeVerify(ctx -> {
        ENTERED.countDown();
        try {
          RELEASE.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
        return HookResults.BeforeResult.proceed();
      });
    }
  }

  @BeforeEach
  void reset() {
    recorder.reset();
  }

  @Test
  void aVerifiedPaymentWhoseClientLeftDuringVerifyRunsTheCancelHooks() throws Exception {
    String url = "http://127.0.0.1:" + port + "/weather";
    HttpResponse<String> unpaid = TestHttp.get(url);
    assertThat(unpaid.statusCode()).isEqualTo(402);
    recorder.reset();

    HttpRequest request = HttpRequest.newBuilder(URI.create(url))
        .timeout(Duration.ofMillis(500))
        .header(X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, null)).build();
    try {
      HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    } catch (HttpTimeoutException expected) {
      // the client gave up while verify was running
    }
    assertThat(ENTERED.await(5, TimeUnit.SECONDS)).isTrue();
    Thread.sleep(500);
    RELEASE.countDown();
    TestHttp.await(Duration.ofSeconds(5), () -> recorder.canceled.get() == 1);
    assertThat(recorder.cancelReasons).hasSize(1);
    assertThat(recorder.settled.get()).isZero();
  }
}
