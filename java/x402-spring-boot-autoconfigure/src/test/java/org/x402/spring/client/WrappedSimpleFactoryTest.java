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
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.http.client.BufferingClientHttpRequestFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.http.HeaderCodec;
import org.x402.http.HostPolicy;
import org.x402.http.X402Headers;
import org.x402.spring.HookRecorder;
import org.x402.spring.TestClientScheme;
import org.x402.spring.client.servlet.X402ClientHttpRequestFactoryDecorator;

/**
 * A {@code SimpleClientHttpRequestFactory} reached through a wrapper cannot have redirects
 * switched off on its paid connection, so it is not trusted.
 */
class WrappedSimpleFactoryTest {

  private static WireMockServer api;
  private static WireMockServer elsewhere;

  @BeforeAll
  static void start() {
    api = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    elsewhere = new WireMockServer(WireMockConfiguration.options().dynamicPort());
    api.start();
    elsewhere.start();
    String header = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(api.baseUrl() + "/redirect"), List.of(new PaymentRequirements("exact",
            HookRecorder.NET, "USDM", "10000", "addr", 300, Map.of())), null));
    api.stubFor(get(urlEqualTo("/redirect")).withHeader(X402Headers.PAYMENT_SIGNATURE, absent())
        .willReturn(aResponse().withStatus(402).withHeader(X402Headers.PAYMENT_REQUIRED, header)));
    api.stubFor(get(urlEqualTo("/redirect"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+"))
        .willReturn(aResponse().withStatus(302)
            .withHeader("Location", elsewhere.baseUrl() + "/landing")));
    elsewhere.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200)));
  }

  @AfterAll
  static void stop() {
    api.stop();
    elsewhere.stop();
  }

  @Test
  void aBufferingWrappedSimpleFactoryNeverForwardsThePaidRequest() {
    TestClientScheme scheme = new TestClientScheme();
    X402Client client = new X402Client().register(HookRecorder.NET, scheme);
    X402ClientHttpRequestFactoryDecorator decorator = new X402ClientHttpRequestFactoryDecorator(
        client, HostPolicy.of(List.of("localhost")));
    RestClient rest = RestClient.builder().requestFactory(decorator.decorate(
        new BufferingClientHttpRequestFactory(new SimpleClientHttpRequestFactory()))).build();

    try {
      rest.get().uri(api.baseUrl() + "/redirect").retrieve().toEntity(String.class);
    } catch (HttpClientErrorException e) {
      assertThat(e.getStatusCode().value()).isEqualTo(402);
    }
    assertThat(elsewhere.countRequestsMatching(anyRequestedFor(anyUrl())
        .withHeader(X402Headers.PAYMENT_SIGNATURE, matching(".+")).build()).getCount()).isZero();
    assertThat(elsewhere.countRequestsMatching(anyRequestedFor(anyUrl()).build()).getCount())
        .isZero();
  }
}
