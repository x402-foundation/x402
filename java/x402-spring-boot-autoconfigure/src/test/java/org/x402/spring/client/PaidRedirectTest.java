package org.x402.spring.client;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import java.net.http.HttpClient;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.X402ClientCustomizer;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/**
 * A paid request is never redirected: an allowed host answering the
 * paid retry with a 3xx to another origin never gets {@code PAYMENT-SIGNATURE} forwarded; the
 * caller gets the 3xx.
 */
@ExtendWith(OutputCaptureExtension.class)
class PaidRedirectTest {

  private static WireMockServer api;
  private static WireMockServer elsewhere;
  private ConfigurableApplicationContext context;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {
    @Bean
    X402ClientCustomizer testSchemes() {
      return client -> client.register(HookRecorder.NET, new TestClientScheme());
    }

    @Bean
    RestClient followingButSafe(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      HttpClient follows = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS)
          .build();
      HttpClient never = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
          .build();
      return RestClient.builder().requestFactory(x402Decorator.decorate(
          new JdkClientHttpRequestFactory(follows), new JdkClientHttpRequestFactory(never)))
          .build();
    }

    @Bean
    RestClient followingOneArg(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      HttpClient follows = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.ALWAYS)
          .build();
      return RestClient.builder().requestFactory(x402Decorator.decorate(
          new JdkClientHttpRequestFactory(follows))).build();
    }
  }

  @BeforeAll
  static void startServers() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    elsewhere = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
    elsewhere.start();
  }

  @AfterAll
  static void stopServers() {
    api.stop();
    elsewhere.stop();
  }

  @BeforeEach
  void stubs() {
    api.resetAll();
    elsewhere.resetAll();
    String header = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(api.baseUrl() + "/redirect"), List.of(new PaymentRequirements("exact",
            HookRecorder.NET, "USDM", "10000", "addr", 300, Map.of())), null));
    api.stubFor(get(urlEqualTo("/redirect")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402).withHeader(X402Headers.PAYMENT_REQUIRED, header)));
    api.stubFor(get(urlEqualTo("/redirect"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+"))
        .willReturn(aResponse().withStatus(302)
            .withHeader("Location", elsewhere.baseUrl() + "/landing")));
    elsewhere.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200).withBody("stolen")));
  }

  @AfterEach
  void close() {
    if (context != null) {
      context.close();
    }
  }

  private void start(String... properties) {
    List<String> all = new java.util.ArrayList<>(List.of(
        "spring.main.web-application-type=none",
        "x402.client.enabled=true",
        "x402.client.hosts[0]=localhost",
        "spring.http.client.redirects=follow"));
    all.addAll(List.of(properties));
    context = new SpringApplicationBuilder(App.class).properties(all.toArray(String[]::new))
        .run();
  }

  private void assertNotForwarded(ResponseEntity<String> response) {
    assertThat(response.getStatusCode().value()).isEqualTo(302);
    assertThat(elsewhere.countRequestsMatching(anyRequestedFor(anyUrl()).build()).getCount())
        .isZero();
  }

  @ParameterizedTest
  @ValueSource(strings = {"jdk", "simple", "reactor"})
  void bootBuiltClientsNeverFollowARedirectOfThePaidRequest(String factory) {
    start("spring.http.client.factory=" + factory);
    RestClient client = context.getBean(RestClient.Builder.class).build();
    assertNotForwarded(client.get().uri(api.baseUrl() + "/redirect").retrieve()
        .toEntity(String.class));
    assertNotForwarded(context.getBean(RestTemplateBuilder.class).build()
        .getForEntity(api.baseUrl() + "/redirect", String.class));
  }

  @Test
  void aDecoratedClientSendsThePaidRequestThroughTheNonRedirectingFactory() {
    start();
    assertNotForwarded(context.getBean("followingButSafe", RestClient.class).get()
        .uri(api.baseUrl() + "/redirect").retrieve().toEntity(String.class));
  }

  @Test
  void theOneArgumentDecorateWarnsThatItsFactoryMayFollowRedirects(CapturedOutput output) {
    start();
    assertThat(output.getOut() + output.getErr())
        .contains("decorate(factory, nonRedirectingFactory)");
  }
}
