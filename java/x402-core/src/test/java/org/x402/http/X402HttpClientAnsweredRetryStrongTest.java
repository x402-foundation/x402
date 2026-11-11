package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.core.Fixtures.PREPROD;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
import static com.github.tomakehurst.wiremock.client.WireMock.matching;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.options;

import com.github.tomakehurst.wiremock.WireMockServer;
import java.net.URI;
import java.net.http.HttpClient.Redirect;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FakeClientScheme;
import org.x402.core.Fixtures;
import org.x402.core.client.X402Client;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.ResourceInfo;
import org.x402.http.ScriptedTransport.Reply;

/**
 * Pins the paid retry without a HostPolicy against a scripted delegate that claims to have followed
 * redirects itself: the retry goes to the answering URI (path and query), keeps the answered
 * method and body, drops body headers when the body is dropped, and strips credentials exactly when
 * the answering origin differs (except a default-port http-to-https upgrade on the same host).
 */
class X402HttpClientAnsweredRetryStrongTest {

  private final X402Client x402 = new X402Client().register(PREPROD, new FakeClientScheme());

  private static String required(String url) {
    return HeaderCodec.encodePaymentRequired(new PaymentRequired(2, "Payment required",
        ResourceInfo.of(url), List.of(Fixtures.requirements()), null));
  }

  private static boolean paid(HttpRequest r) {
    return r.headers().firstValue("PAYMENT-SIGNATURE").isPresent();
  }

  /** Sends {@code first}; the delegate "followed a redirect" and the 402 came from {@code answered}. */
  private HttpRequest paidRetry(HttpRequest first, HttpRequest answered) throws Exception {
    String answeredUrl = answered.uri().toString();
    ScriptedTransport transport = new ScriptedTransport(r -> paid(r)
        ? new Reply(200, Map.of(), 2)
        : new Reply(402, Map.of("PAYMENT-REQUIRED", required(answeredUrl)), 10, answered),
        Redirect.NORMAL);
    HttpResponse<String> response = X402HttpClient.wrap(transport, x402).send(first,
        HttpResponse.BodyHandlers.ofString());
    assertThat(response.statusCode()).isEqualTo(200);
    assertThat(transport.requests).hasSize(2);
    HttpRequest retry = transport.requests.get(1);
    assertThat(paid(retry)).isTrue();
    return retry;
  }

  @Test
  void theRetryTargetsTheAnsweringUriIncludingPathAndQuery() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("http://localhost:8080/old?a=1")).build(),
        HttpRequest.newBuilder(URI.create("http://localhost:8080/new/place?b=2&c=3")).build());

    assertThat(retry.uri()).isEqualTo(URI.create("http://localhost:8080/new/place?b=2&c=3"));
    assertThat(retry.method()).isEqualTo("GET");
  }

  @Test
  void aPostRedirectedWith307IsPaidAsAPostWithItsBodyAtTheAnsweringUri() throws Exception {
    WireMockServer origin = new WireMockServer(options().dynamicPort());
    origin.start();
    try {
      String url = "http://localhost:" + origin.port() + "/moved?x=1";
      origin.stubFor(post(urlEqualTo("/submit")).willReturn(aResponse().withStatus(307)
          .withHeader("Location", "/moved?x=1")));
      origin.stubFor(post(urlEqualTo("/moved?x=1")).withHeader("PAYMENT-SIGNATURE", absent())
          .willReturn(aResponse().withStatus(402).withHeader("PAYMENT-REQUIRED", required(url))));
      origin.stubFor(post(urlEqualTo("/moved?x=1")).withHeader("PAYMENT-SIGNATURE", matching(".+"))
          .willReturn(aResponse().withStatus(200).withBody("paid")));
      java.net.http.HttpClient client = X402HttpClient.wrap(java.net.http.HttpClient.newBuilder()
          .followRedirects(Redirect.ALWAYS).build(), x402);

      HttpResponse<String> response = client.send(HttpRequest.newBuilder(
          URI.create("http://localhost:" + origin.port() + "/submit"))
          .header("Content-Type", "application/json")
          .POST(BodyPublishers.ofString("{\"a\":1}")).build(), HttpResponse.BodyHandlers.ofString());

      assertThat(response.statusCode()).isEqualTo(200);
      origin.verify(1, postRequestedFor(urlEqualTo("/moved?x=1"))
          .withHeader("PAYMENT-SIGNATURE", matching(".+"))
          .withHeader("Content-Type", equalTo("application/json"))
          .withRequestBody(equalTo("{\"a\":1}")));
      origin.verify(0, postRequestedFor(urlEqualTo("/submit"))
          .withHeader("PAYMENT-SIGNATURE", matching(".+")));
    } finally {
      origin.stop();
    }
  }

  @Test
  void aPostAnsweredAsAGetIsRetriedWithoutBodyAndBodyHeaders() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("http://localhost:8080/submit"))
            .header("Content-Type", "application/json").header("X-Trace", "t1")
            .POST(BodyPublishers.ofString("{\"a\":1}")).build(),
        HttpRequest.newBuilder(URI.create("http://localhost:8080/result")).build());

    assertThat(retry.method()).isEqualTo("GET");
    assertThat(retry.bodyPublisher().map(p -> p.contentLength()).orElse(0L)).isZero();
    assertThat(retry.headers().firstValue("Content-Type")).isEmpty();
    assertThat(retry.headers().firstValue("X-Trace")).contains("t1");
  }

  @Test
  void crossOriginAnswerStripsEveryCredentialHeaderButKeepsOthers() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("https://api.example.com/x"))
            .header("Authorization", "Bearer t").header("Cookie", "s=1")
            .header("Proxy-Authorization", "Basic p").header("X-Api-Key", "k")
            .header("X-Trace", "t1").build(),
        HttpRequest.newBuilder(URI.create("https://cdn.example.com/x")).build());

    assertThat(retry.headers().firstValue("Authorization")).isEmpty();
    assertThat(retry.headers().firstValue("Cookie")).isEmpty();
    assertThat(retry.headers().firstValue("Proxy-Authorization")).isEmpty();
    assertThat(retry.headers().firstValue("X-Api-Key")).isEmpty();
    assertThat(retry.headers().firstValue("X-Trace")).contains("t1");
  }

  @Test
  void aDifferentPortOnTheSameHostIsAnotherOrigin() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("https://api.example.com/x"))
            .header("Authorization", "Bearer t").build(),
        HttpRequest.newBuilder(URI.create("https://api.example.com:8443/x")).build());

    assertThat(retry.headers().firstValue("Authorization")).isEmpty();
  }

  @Test
  void anHttpsDowngradeOnTheSameHostLosesCredentials() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("https://api.example.com/x"))
            .header("Authorization", "Bearer t").build(),
        HttpRequest.newBuilder(URI.create("http://api.example.com/x")).build());

    assertThat(retry.headers().firstValue("Authorization")).isEmpty();
  }

  @Test
  void anUpgradeFromANonDefaultPortLosesCredentials() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("http://api.example.com:8080/x"))
            .header("Authorization", "Bearer t").build(),
        HttpRequest.newBuilder(URI.create("https://api.example.com/x")).build());

    assertThat(retry.headers().firstValue("Authorization")).isEmpty();
  }

  @Test
  void anUpgradeToANonDefaultHttpsPortLosesCredentials() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("http://api.example.com/x"))
            .header("Authorization", "Bearer t").build(),
        HttpRequest.newBuilder(URI.create("https://api.example.com:8443/x")).build());

    assertThat(retry.headers().firstValue("Authorization")).isEmpty();
  }

  @Test
  void aSameOriginAnswerOnAnotherPathKeepsCredentials() throws Exception {
    HttpRequest retry = paidRetry(
        HttpRequest.newBuilder(URI.create("https://api.example.com/old"))
            .header("Authorization", "Bearer t").header("Cookie", "s=1").build(),
        HttpRequest.newBuilder(URI.create("https://API.example.com/new")).build());

    assertThat(retry.headers().firstValue("Authorization")).contains("Bearer t");
    assertThat(retry.headers().firstValue("Cookie")).contains("s=1");
  }
}
