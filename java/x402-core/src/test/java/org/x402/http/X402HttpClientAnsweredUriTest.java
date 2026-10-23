package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.anyRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.anyUrl;
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
 * The paid retry goes to the URI that answered 402, with the method and body of the request that
 * was answered, whether the redirect before it was followed by the wrapper or by the delegate.
 */
class X402HttpClientAnsweredUriTest {

  private final WireMockServer origin = new WireMockServer(options().dynamicPort());
  private final WireMockServer other = new WireMockServer(options().dynamicPort());
  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());

  @BeforeEach
  void start() {
    origin.start();
    other.start();
  }

  @AfterEach
  void stop() {
    origin.stop();
    other.stop();
  }

  private static String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  private void paywall(String path) {
    String url = "http://localhost:" + origin.port() + path;
    origin.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED", required(url))));
    origin.stubFor(get(urlEqualTo(path)).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(200).withBody("paid")));
  }

  @Test
  void aPostRedirectedWith303AndAnswered402IsPaidAsAGetToTheAnsweringUri() throws Exception {
    origin.stubFor(post(urlEqualTo("/submit")).willReturn(aResponse().withStatus(303)
        .withHeader("Location", "/result")));
    paywall("/result");
    HttpClient client = X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.ALWAYS).build(), x402);

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(
        URI.create("http://localhost:" + origin.port() + "/submit"))
        .header("Content-Type", "application/json")
        .POST(BodyPublishers.ofString("{\"a\":1}")).build(), BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(response.body()).isEqualTo("paid");
    origin.verify(1, getRequestedFor(urlEqualTo("/result")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
    origin.verify(0, postRequestedFor(urlEqualTo("/submit")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
    origin.verify(1, postRequestedFor(urlEqualTo("/submit")));
  }

  @Test
  void aGetRedirectedByTheDelegateIsPaidAtTheUriThatAnswered() throws Exception {
    origin.stubFor(get(urlEqualTo("/old")).willReturn(aResponse().withStatus(301)
        .withHeader("Location", "/new")));
    paywall("/new");
    HttpClient client = X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.ALWAYS).build(), x402);

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(
        URI.create("http://localhost:" + origin.port() + "/old")).build(),
        BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    origin.verify(1, getRequestedFor(urlEqualTo("/new")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
    origin.verify(0, getRequestedFor(urlEqualTo("/old")).withHeader("PAYMENT-SIGNATURE",
        matching(".+")));
  }

  @Test
  void aPaidLegRedirectToAHostOutsideThePolicyNeverReceivesTheSignature() throws Exception {
    String url = "http://localhost:" + origin.port() + "/pay";
    origin.stubFor(get(urlEqualTo("/pay")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED", required(url))));
    origin.stubFor(get(urlEqualTo("/pay")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(302).withHeader("Location",
            "http://127.0.0.1:" + other.port() + "/landing")));
    other.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200).withBody("stolen")));
    HttpClient client = X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER).build(), x402, HostPolicy.of(List.of("localhost")));

    HttpResponse<String> response = client.send(HttpRequest.newBuilder(URI.create(url)).build(),
        BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(302);
    assertThat(other.countRequestsMatching(anyRequestedFor(anyUrl()).build()).getCount()).isZero();
  }

  @Test
  void aPaidLegRedirectToAnotherOriginOnAnAllowedHostDropsTheSignature() throws Exception {
    String url = "http://localhost:" + origin.port() + "/pay";
    origin.stubFor(get(urlEqualTo("/pay")).withHeader("PAYMENT-SIGNATURE", absent())
        .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED", required(url))));
    origin.stubFor(get(urlEqualTo("/pay")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
        .willReturn(aResponse().withStatus(302).withHeader("Location",
            "http://localhost:" + other.port() + "/landing")));
    other.stubFor(get(anyUrl()).willReturn(aResponse().withStatus(200).withBody("landed")));
    HttpClient client = X402HttpClient.wrap(HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER).build(), x402, HostPolicy.of(List.of("localhost")));

    client.send(HttpRequest.newBuilder(URI.create(url)).build(), BodyHandlers.ofString());

    other.verify(0, anyRequestedFor(anyUrl()).withHeader("PAYMENT-SIGNATURE", matching(".+")));
  }
}
