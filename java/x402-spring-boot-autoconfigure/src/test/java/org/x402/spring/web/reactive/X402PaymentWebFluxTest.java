package org.x402.spring.web.reactive;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.netty.NettyReactiveWebServerFactory;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.ReactorResourceFactory;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.reactive.EnableWebFluxSecurity;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.core.userdetails.MapReactiveUserDetailsService;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.x402.http.X402Headers;
import org.x402.spring.ContractApp;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402StarterContract;
import org.x402.spring.annotation.X402Payment;
import reactor.blockhound.BlockHound;
import reactor.blockhound.BlockingOperationError;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * The starter contract on WebFlux (Reactor Netty) under BlockHound, with a leak-detecting buffer
 * factory checked after every test, plus the reactive-only cases.
 */
@SpringBootTest(classes = X402PaymentWebFluxTest.FluxApp.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=reactive")
class X402PaymentWebFluxTest extends X402StarterContract {

  static {
    BlockHound.install();
  }

  @LocalServerPort
  int port;

  @Autowired
  HookRecorder recorder;

  @Autowired
  LeakTrackingBuffers buffers;

  /** Reactive-only handlers. */
  @RestController
  static class ReactiveController {

    @X402Payment("weather")
    @GetMapping("/reactive/void")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    Mono<Void> nothing() {
      return Mono.empty();
    }

    @X402Payment("weather")
    @GetMapping("/reactive/mono")
    Mono<String> later() {
      return Mono.just("later").delayElement(Duration.ofMillis(20));
    }

    @X402Payment("prepaid")
    @GetMapping("/reactive/events")
    Flux<ServerSentEvent<String>> events() {
      return Flux.just("a", "b").map(s -> ServerSentEvent.builder(s).build());
    }
  }

  /** Only loaded by the streaming variant. */
  @RestController
  static class StreamingController {
    @X402Payment("weather")
    @GetMapping("/stream")
    Flux<ServerSentEvent<String>> stream() {
      return Flux.just(ServerSentEvent.builder("x").build());
    }
  }

  @Configuration(proxyBeanMethods = false)
  static class Leaks {
    @Bean
    LeakTrackingBuffers leakTrackingBuffers() {
      return new LeakTrackingBuffers();
    }
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  @Import({ContractApp.class, ReactiveController.class, Leaks.class})
  static class FluxApp {
    /** Own event loops per context, so closing a variant app cannot stop the main server. */
    @Bean
    ReactorResourceFactory reactorResourceFactory() {
      ReactorResourceFactory resources = new ReactorResourceFactory();
      resources.setUseGlobalResources(false);
      return resources;
    }

    /**
     * Reactor Netty, not Tomcat (which Boot prefers when both are on the test classpath), bound
     * dual-stack so {@code localhost} reaches it over IPv6 and IPv4.
     */
    @Bean
    NettyReactiveWebServerFactory nettyReactiveWebServerFactory(ReactorResourceFactory resources)
        throws Exception {
      NettyReactiveWebServerFactory factory = new NettyReactiveWebServerFactory();
      factory.setResourceFactory(resources);
      factory.setAddress(java.net.InetAddress.getByName("::"));
      return factory;
    }
  }

  /** Every request needs authentication. */
  @Configuration(proxyBeanMethods = false)
  @EnableWebFluxSecurity
  static class Secured {
    @Bean
    MapReactiveUserDetailsService users() {
      return new MapReactiveUserDetailsService(User.withUsername("user").password("{noop}pw")
          .roles("USER").build());
    }

    @Bean
    SecurityWebFilterChain everythingAuthenticated(ServerHttpSecurity http) {
      return http.authorizeExchange(e -> e.anyExchange().authenticated())
          .httpBasic(Customizer.withDefaults()).build();
    }
  }

  @Override
  protected int port() {
    return port;
  }

  @Override
  protected HookRecorder recorder() {
    return recorder;
  }

  @Override
  protected ConfigurableApplicationContext startVariant(Map<String, Object> overrides,
      Class<?>... extra) {
    Map<String, Object> props = new LinkedHashMap<>(contractProperties());
    props.put("server.port", "0");
    props.put("spring.main.web-application-type", "reactive");
    props.putAll(overrides);
    Class<?>[] sources = new Class<?>[extra.length + 1];
    sources[0] = FluxApp.class;
    System.arraycopy(extra, 0, sources, 1, extra.length);
    return new SpringApplicationBuilder(sources).properties(props).run();
  }

  @Override
  protected Class<?> securityConfiguration() {
    return Secured.class;
  }

  @Override
  protected String contextPathProperty() {
    return "spring.webflux.base-path";
  }

  @AfterEach
  void everyBufferWasReleased() {
    TestHttp.await(Duration.ofSeconds(5), () -> buffers.unreleased() == 0);
    buffers.reset();
  }

  private String url(String path) {
    return "http://127.0.0.1:" + port + path;
  }

  private HttpResponse<String> paidGet(String path) {
    HttpResponse<String> unpaid = TestHttp.get(url(path));
    assertThat(unpaid.statusCode()).isEqualTo(402);
    return TestHttp.get(url(path), X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, null));
  }

  @Test
  void blockHoundIsActive() {
    assertThatThrownBy(() -> Mono.fromCallable(() -> {
      Thread.sleep(1);
      return 1;
    }).subscribeOn(Schedulers.parallel()).block()).hasCauseInstanceOf(
        BlockingOperationError.class);
  }

  @Test
  void aMonoVoidHandlerIsSettledThroughSetComplete() {
    HttpResponse<String> response = paidGet("/reactive/void");

    assertThat(response.statusCode()).isEqualTo(204);
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
  }

  @Test
  void aDelayedMonoIsBufferedAndSettled() {
    HttpResponse<String> response = paidGet("/reactive/mono");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("later");
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(buffers.created()).isPositive();
  }

  @Test
  void anUpfrontStreamIsDeliveredThroughWriteAndFlushWithAndCarriesItsReceipt() {
    HttpResponse<String> response = paidGet("/reactive/events");

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).contains("data:a").contains("data:b");
    assertThat(TestHttp.settlement(response)).isNotNull();
    assertThat(FACILITATOR.count("settle")).isEqualTo(1);
  }

  @Test
  void paidStreamingHandlersOnAuthorizationOffersAreRejectedAtStartup() {
    assertThatThrownBy(() -> startVariant(Map.of(), StreamingController.class).close())
        .hasStackTraceContaining("stream");
  }
}
