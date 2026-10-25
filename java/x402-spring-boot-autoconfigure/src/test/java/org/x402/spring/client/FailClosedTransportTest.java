package org.x402.spring.client;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.core.WireMockConfiguration;
import java.net.http.HttpClient;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.ClientHttpRequestFactory;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.http.client.reactive.ClientHttpConnector;
import org.springframework.http.client.reactive.JdkClientHttpConnector;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.client.WebClientResponseException;
import org.x402.core.client.X402ClientException;
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
 * Fail closed on unverifiable transports: a payment
 * is signed only when the paid request provably cannot follow a redirect. A transport known to
 * follow redirects refuses the payment; an unknown one gets the 402 back unpaid; nothing is
 * signed in either case.
 */
@ExtendWith(OutputCaptureExtension.class)
class FailClosedTransportTest {

  private static WireMockServer api;
  private ConfigurableApplicationContext context;

  private static HttpClient jdk(HttpClient.Redirect redirect) {
    return HttpClient.newBuilder().followRedirects(redirect).build();
  }

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {
    @Bean
    TestClientScheme testClientScheme() {
      return new TestClientScheme();
    }

    @Bean
    X402ClientCustomizer testSchemes(TestClientScheme scheme) {
      return client -> client.register(HookRecorder.NET, scheme);
    }

    @Bean
    WebClient jdkFollowingWebClient() {
      return WebClient.builder().clientConnector(new JdkClientHttpConnector(
          jdk(HttpClient.Redirect.NORMAL))).build();
    }

    @Bean
    WebClient jdkNeverWebClient() {
      return WebClient.builder().clientConnector(new JdkClientHttpConnector(
          jdk(HttpClient.Redirect.NEVER))).build();
    }

    @Bean
    WebClient unknownConnectorWebClient() {
      ClientHttpConnector inner = new JdkClientHttpConnector(jdk(HttpClient.Redirect.NEVER));
      ClientHttpConnector opaque = inner::connect;
      return WebClient.builder().clientConnector(opaque).build();
    }

    @Bean
    RestClient jdkFollowingRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      return RestClient.builder().requestFactory(x402Decorator.decorate(
          new JdkClientHttpRequestFactory(jdk(HttpClient.Redirect.NORMAL)))).build();
    }

    @Bean
    RestClient unknownFactoryRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      ClientHttpRequestFactory inner =
          new JdkClientHttpRequestFactory(jdk(HttpClient.Redirect.NEVER));
      ClientHttpRequestFactory opaque = inner::createRequest;
      return RestClient.builder().requestFactory(x402Decorator.decorate(opaque)).build();
    }

    @Bean
    RestClient simpleRestClient(X402ClientHttpRequestFactoryDecorator x402Decorator) {
      return RestClient.builder().requestFactory(x402Decorator.decorate(
          new SimpleClientHttpRequestFactory())).build();
    }
  }

  @BeforeAll
  static void startApi() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
  }

  @AfterAll
  static void stopApi() {
    api.stop();
  }

  @BeforeEach
  void stubs() {
    api.resetAll();
    for (String path : List.of("/paid", "/redirect")) {
      String header = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
          ResourceInfo.of(api.baseUrl() + path), List.of(new PaymentRequirements("exact",
              HookRecorder.NET, "USDM", "10000", "addr", 300, Map.of())), null));
      api.stubFor(get(urlEqualTo(path)).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
          .willReturn(aResponse().withStatus(402)
              .withHeader(X402Headers.PAYMENT_REQUIRED, header)));
    }
    api.stubFor(get(urlEqualTo("/paid")).withHeader(X402Headers.PAYMENT_SIGNATURE,
        matching(".+")).willReturn(aResponse().withStatus(200).withBody("paid")));
    api.stubFor(get(urlEqualTo("/redirect")).withHeader(X402Headers.PAYMENT_SIGNATURE,
        matching(".+")).willReturn(aResponse().withStatus(302)
            .withHeader("Location", api.baseUrl() + "/landing")));
    api.stubFor(get(urlEqualTo("/landing")).willReturn(aResponse().withStatus(200)));
  }

  @AfterEach
  void close() {
    if (context != null) {
      context.close();
    }
  }

  private void start() {
    List<String> props = new ArrayList<>(List.of("spring.main.web-application-type=none",
        "x402.client.enabled=true", "x402.client.hosts[0]=localhost"));
    context = new SpringApplicationBuilder(App.class).properties(props.toArray(String[]::new))
        .run();
  }

  private int paidRequests() {
    return api.countRequestsMatching(anyRequestedFor(anyUrl())
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")).build()).getCount();
  }

  private TestClientScheme scheme() {
    return context.getBean(TestClientScheme.class);
  }

  @Test
  void aWebClientOnARedirectFollowingJdkConnectorRefusesBeforeSigning() {
    start();
    WebClient client = context.getBean("jdkFollowingWebClient", WebClient.class);
    assertThatThrownBy(() -> client.get().uri(api.baseUrl() + "/paid").retrieve()
        .bodyToMono(String.class).block())
        .hasRootCauseInstanceOf(X402ClientException.class)
        .rootCause().hasMessageContaining("redirect");
    assertThat(scheme().signed).isEmpty();
    assertThat(paidRequests()).isZero();
  }

  @Test
  void aWebClientOnANonRedirectingJdkConnectorPays() {
    start();
    assertThat(context.getBean("jdkNeverWebClient", WebClient.class).get()
        .uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class).block())
        .isEqualTo("paid");
    assertThat(scheme().signed).hasSize(1);
  }

  @Test
  void aWebClientOnAnUnknownConnectorGetsThe402BackUnpaid(CapturedOutput output) {
    start();
    assertThatThrownBy(() -> context.getBean("unknownConnectorWebClient", WebClient.class).get()
        .uri(api.baseUrl() + "/paid").retrieve().bodyToMono(String.class).block())
        .isInstanceOf(WebClientResponseException.class)
        .satisfies(e -> assertThat(((WebClientResponseException) e).getStatusCode().value())
            .isEqualTo(402));
    assertThat(scheme().signed).isEmpty();
    assertThat(paidRequests()).isZero();
    assertThat(output.getOut() + output.getErr()).contains("cannot verify");
  }

  @Test
  void aOneArgumentDecorateOverARedirectFollowingJdkFactoryRefusesBeforeSigning() {
    start();
    RestClient client = context.getBean("jdkFollowingRestClient", RestClient.class);
    assertThatThrownBy(() -> client.get().uri(api.baseUrl() + "/paid").retrieve()
        .body(String.class))
        .hasRootCauseInstanceOf(X402ClientException.class)
        .rootCause().hasMessageContaining("redirect");
    assertThat(scheme().signed).isEmpty();
    assertThat(paidRequests()).isZero();
  }

  @Test
  void aOneArgumentDecorateOverAnUnknownFactoryGetsThe402BackUnpaid(CapturedOutput output) {
    start();
    assertThatThrownBy(() -> context.getBean("unknownFactoryRestClient", RestClient.class).get()
        .uri(api.baseUrl() + "/paid").retrieve().body(String.class))
        .isInstanceOf(HttpClientErrorException.class);
    assertThat(scheme().signed).isEmpty();
    assertThat(paidRequests()).isZero();
    assertThat(output.getOut() + output.getErr()).contains("cannot verify")
        .contains("decorate(factory, nonRedirectingFactory)");
  }

  @Test
  void aSimpleFactoryPaysAndItsPaidRequestDoesNotFollowRedirects() {
    start();
    RestClient client = context.getBean("simpleRestClient", RestClient.class);
    assertThat(client.get().uri(api.baseUrl() + "/paid").retrieve().body(String.class))
        .isEqualTo("paid");
    ResponseEntity<String> redirected = client.get().uri(api.baseUrl() + "/redirect")
        .retrieve().toEntity(String.class);
    assertThat(redirected.getStatusCode().value()).isEqualTo(302);
    assertThat(api.countRequestsMatching(getRequestedFor(urlEqualTo("/landing")).build())
        .getCount()).isZero();
  }
}
