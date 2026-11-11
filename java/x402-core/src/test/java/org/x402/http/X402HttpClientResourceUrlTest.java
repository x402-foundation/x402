package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;

import com.github.tomakehurst.wiremock.WireMockServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;

/**
 * With a host policy, the host of {@code PAYMENT-REQUIRED.resource.url} must also be on
 * the list, so a 402 without a resource URL is returned unpaid.
 */
class X402HttpClientResourceUrlTest {

  private final WireMockServer wm = new WireMockServer(options().dynamicPort());
  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());

  @BeforeEach
  void start() {
    wm.start();
  }

  @AfterEach
  void stop() {
    wm.stop();
  }

  private HttpResponse<String> call(ResourceInfo resource) throws Exception {
    String header = HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        resource, List.of(Fixtures.requirements()), null));
    wm.stubFor(get(urlEqualTo("/paid")).willReturn(aResponse().withStatus(402)
        .withHeader(X402Headers.PAYMENT_REQUIRED, header)));
    HttpClient client = X402HttpClient.wrap(
        HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build(), x402,
        HostPolicy.of(List.of("localhost")));
    return client.send(HttpRequest.newBuilder(
        URI.create("http://localhost:" + wm.port() + "/paid")).build(), BodyHandlers.ofString());
  }

  @Test
  void aMissingResourceIsReturnedUnpaid() throws Exception {
    HttpResponse<String> response = call(null);

    assertThat(response.statusCode()).isEqualTo(402);
    wm.verify(1, getRequestedFor(urlEqualTo("/paid")));
    wm.verify(getRequestedFor(urlEqualTo("/paid"))
        .withHeader(X402Headers.PAYMENT_SIGNATURE, absent()));
  }

  @Test
  void anUnparsableResourceUrlIsReturnedUnpaid() throws Exception {
    HttpResponse<String> response = call(ResourceInfo.of("not a url ::"));

    assertThat(response.statusCode()).isEqualTo(402);
    wm.verify(1, getRequestedFor(urlEqualTo("/paid")));
  }
}
