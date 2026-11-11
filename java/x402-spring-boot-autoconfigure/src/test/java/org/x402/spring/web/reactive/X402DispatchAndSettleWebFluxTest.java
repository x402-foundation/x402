package org.x402.spring.web.reactive;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.web.embedded.netty.NettyReactiveWebServerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.core.Ordered;
import org.springframework.http.client.ReactorResourceFactory;
import org.springframework.web.server.WebFilter;
import org.x402.http.X402Headers;
import org.x402.spring.ContractApp;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestHttp;
import org.x402.spring.X402DispatchAndSettleContract;

/** The dispatch and settle contract on WebFlux, plus settle surviving a cancelled request. */
@SpringBootTest(classes = X402DispatchAndSettleWebFluxTest.App.class,
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = "spring.main.web-application-type=reactive")
class X402DispatchAndSettleWebFluxTest extends X402DispatchAndSettleContract {

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

    /** Runs after x402 and rewrites one path. */
    @Bean
    WebFilter rewriting() {
      return new OrderedRewrite();
    }
  }

  /** A lowest-precedence path rewrite. */
  static final class OrderedRewrite implements WebFilter, Ordered {
    @Override
    public reactor.core.publisher.Mono<Void> filter(
        org.springframework.web.server.ServerWebExchange exchange,
        org.springframework.web.server.WebFilterChain chain) {
      if (!"/rewrite-to-weather".equals(exchange.getRequest().getPath().value())) {
        return chain.filter(exchange);
      }
      return chain.filter(exchange.mutate()
          .request(r -> r.path("/weather")).build());
    }

    @Override
    public int getOrder() {
      return Ordered.LOWEST_PRECEDENCE;
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

  @Test
  void aSettleThatStartedCompletesWhenTheClientGoesAway() throws Exception {
    HttpResponse<String> unpaid = TestHttp.get(url("/weather"));
    HttpClient impatient = HttpClient.newHttpClient();
    HttpRequest request = HttpRequest.newBuilder(URI.create(url("/weather")))
        .timeout(Duration.ofMillis(400))
        .header(X402Headers.PAYMENT_SIGNATURE, TestHttp.pay(unpaid, 0, "slow-settle")).build();
    try {
      impatient.send(request, HttpResponse.BodyHandlers.ofString());
    } catch (HttpTimeoutException expected) {
      // the client gave up while settle was running
    }
    TestHttp.await(Duration.ofSeconds(5), () -> recorder.settled.get() == 1);
    assertThat(facilitator().count("settle")).isEqualTo(1);
    assertThat(recorder.canceled.get()).isZero();
  }
}
