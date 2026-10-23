package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.get;
import static com.github.tomakehurst.wiremock.client.WireMock.getRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;
import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;

import com.github.tomakehurst.wiremock.WireMockServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
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
 * The paid retry goes to the policy-checked URI that answered 402 (an
 * off-list first host never receives {@code PAYMENT-SIGNATURE}); an empty request body is
 * replayable.
 */
class X402HttpClientPaidRetryTest {

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

  private String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  @Test
  void anOffListFirstHostRedirectingToAnAllowedPaywallNeverReceivesTheSignature()
      throws Exception {
    URI offList = URI.create("http://127.0.0.1:" + wm.port() + "/x");
    String premium = "http://localhost:" + wm.port() + "/premium";
    wm.stubFor(get(urlEqualTo("/x")).willReturn(aResponse().withStatus(302)
        .withHeader("Location", premium)));
    wm.stubFor(get(urlEqualTo("/premium")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED",
            required(premium))));
    wm.stubFor(get(urlEqualTo("/premium")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(200).withBody("premium")));
    HttpClient client = X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER).build(), x402,
        HostPolicy.of(List.of("localhost")));

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(offList).build(),
        BodyHandlers.ofString());

    wm.verify(0, getRequestedFor(urlEqualTo("/x")).withHeader("PAYMENT-SIGNATURE",
        matching(".*")));
    wm.verify(1, getRequestedFor(urlEqualTo("/premium")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("premium");
    assertThat(response.uri().getPath()).isEqualTo("/premium");
  }

  @Test
  void anEmptyRequestBodyIsReplayable() throws Exception {
    wm.stubFor(post(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED",
            required("http://localhost/job"))));
    wm.stubFor(post(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(201)));
    HttpClient client = X402HttpClient.wrap(HttpClient.newHttpClient(), x402);
    HttpResponse<String> response = client.send(HttpRequest.newBuilder(
        URI.create("http://localhost:" + wm.port() + "/job")).POST(BodyPublishers.noBody())
        .build(), BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(201);
    wm.verify(1, postRequestedFor(urlEqualTo("/job")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
  }
}
