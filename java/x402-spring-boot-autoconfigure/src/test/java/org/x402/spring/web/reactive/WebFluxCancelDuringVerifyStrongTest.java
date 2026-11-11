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
import java.util.concurrent.atomic.AtomicBoolean;
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
 * Tightens {@code WebFluxCancelDuringVerifyTest}: the cancel hooks of a payment verified for a
 * departed client run exactly once (not twice, not zero, with the documented reason), and a
 * request that is still connected when its slow verify finishes is settled and never cancelled.
 */
@SpringBootTest(classes = WebFluxCancelDuringVerifyStrongTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=reactive")
class WebFluxCancelDuringVerifyStrongTest {

  static volatile CountDownLatch entered = new CountDownLatch(1);
  static volatile CountDownLatch release = new CountDownLatch(1);
  static final AtomicBoolean ARMED = new AtomicBoolean();

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

    /** While armed, holds the next verify until the test lets it go. */
    @Bean
    X402ResourceServerCustomizer blockingVerify() {
      return server -> server.onBeforeVerify(ctx -> {
        if (ARMED.compareAndSet(true, false)) {
          entered.countDown();
          try {
            release.await(10, TimeUnit.SECONDS);
          } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
          }
        }
        return HookResults.BeforeResult.proceed();
      });
    }
  }

  @BeforeEach
  void reset() {
    recorder.reset();
    entered = new CountDownLatch(1);
    release = new CountDownLatch(1);
    ARMED.set(false);
  }

  private String url() {
    return "http://127.0.0.1:" + port + "/weather";
  }

  @Test
  void theCancelHooksRunExactlyOnceWithTheHandlerThrewReason() throws Exception {
    HttpResponse<String> unpaid = TestHttp.get(url());
    assertThat(unpaid.statusCode()).isEqualTo(402);
    recorder.reset();
    ARMED.set(true);

    HttpRequest request = HttpRequest.newBuilder(URI.create(url()))
        .timeout(Duration.ofMillis(400))
        .header(X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, null)).build();
    try {
      HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());
    } catch (HttpTimeoutException expected) {
      // the client gave up while verify was running
    }
    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
    Thread.sleep(500);
    assertThat(recorder.canceled.get()).as("not cancelled while verify still runs").isZero();
    release.countDown();

    TestHttp.await(Duration.ofSeconds(5), () -> recorder.canceled.get() >= 1);
    Thread.sleep(1500);
    assertThat(recorder.canceled.get()).isEqualTo(1);
    assertThat(recorder.cancelReasons).containsExactly("handler_threw");
    assertThat(recorder.settled.get()).isZero();
  }

  @Test
  void aSlowVerifyOfAClientThatStaysIsSettledAndNeverCancelled() throws Exception {
    HttpResponse<String> unpaid = TestHttp.get(url());
    assertThat(unpaid.statusCode()).isEqualTo(402);
    recorder.reset();
    ARMED.set(true);
    Thread releaser = new Thread(() -> {
      try {
        entered.await(5, TimeUnit.SECONDS);
        Thread.sleep(400);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
      }
      release.countDown();
    });
    releaser.start();

    HttpResponse<String> paid = TestHttp.get(url(), X402Headers.PAYMENT_SIGNATURE,
        TestHttp.pay(unpaid, 0, null));
    releaser.join();

    assertThat(paid.statusCode()).isEqualTo(200);
    assertThat(entered.getCount()).isZero();
    Thread.sleep(1000);
    assertThat(recorder.canceled.get()).isZero();
    assertThat(recorder.cancelReasons).isEmpty();
    assertThat(recorder.settled.get()).isEqualTo(1);
  }
}
