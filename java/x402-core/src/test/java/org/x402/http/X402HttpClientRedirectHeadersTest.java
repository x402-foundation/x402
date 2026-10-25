package org.x402.http;

import static com.github.tomakehurst.wiremock.client.WireMock.absent;
import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.equalTo;
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
import org.x402.core.client.X402Client;

/**
 * Security regression: when {@code X402HttpClient} follows a
 * redirect itself, credential headers must not leak to another origin.
 */
class X402HttpClientRedirectHeadersTest {

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

  private HttpClient client() {
    return X402HttpClient.wrap(HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
        .build(), x402, HostPolicy.of(List.of("localhost")));
  }

  private HttpRequest request(WireMockServer server, String path) {
    return HttpRequest.newBuilder(URI.create("http://localhost:" + server.port() + path))
        .header("Authorization", "Bearer secret")
        .header("Cookie", "session=abc")
        .header("Proxy-Authorization", "Basic xyz")
        .header("X-Api-Key", "k")
        .header("X-Trace", "t1")
        .build();
  }

  @Test
  void crossOriginRedirectDropsCredentialHeaders() throws Exception {
    origin.stubFor(get(urlEqualTo("/start")).willReturn(aResponse().withStatus(302)
        .withHeader("Location", "http://localhost:" + other.port() + "/landing")));
    other.stubFor(get(urlEqualTo("/landing")).willReturn(aResponse().withStatus(200)
        .withBody("ok")));

    HttpResponse<String> response = client().send(request(origin, "/start"),
        BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    other.verify(getRequestedFor(urlEqualTo("/landing"))
        .withHeader("Authorization", absent())
        .withHeader("Cookie", absent())
        .withHeader("Proxy-Authorization", absent())
        .withHeader("X-Api-Key", absent())
        .withHeader("X-Trace", equalTo("t1")));
  }

  @Test
  void sameOriginRedirectKeepsHeaders() throws Exception {
    origin.stubFor(get(urlEqualTo("/start")).willReturn(aResponse().withStatus(302)
        .withHeader("Location", "/landing")));
    origin.stubFor(get(urlEqualTo("/landing")).willReturn(aResponse().withStatus(200)
        .withBody("ok")));

    HttpResponse<String> response = client().send(request(origin, "/start"),
        BodyHandlers.ofString());

    assertThat(response.statusCode()).isEqualTo(200);
    origin.verify(getRequestedFor(urlEqualTo("/landing"))
        .withHeader("Authorization", equalTo("Bearer secret"))
        .withHeader("Cookie", equalTo("session=abc")));
  }
}
