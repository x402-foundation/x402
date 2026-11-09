package org.x402.http;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The facilitator client talks HTTP/1.1 (no h2c upgrade on plain http, which uvicorn and Next.js
 * mishandle) and refuses a base URL that carries credentials, a query or a fragment.
 */
class HttpFacilitatorClientHygieneTest {

  @Test
  void theDefaultClientSendsNoH2cUpgradeOnGetSupported() throws IOException {
    List<String> upgrades = new ArrayList<>();
    HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    server.createContext("/supported", exchange -> {
      String upgrade = exchange.getRequestHeaders().getFirst("Upgrade");
      upgrades.add(upgrade == null ? "<none>" : upgrade);
      byte[] body = "{\"kinds\":[]}".getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().add("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    });
    server.start();
    try {
      HttpFacilitatorClient client = HttpFacilitatorClient.builder()
          .url("http://127.0.0.1:" + server.getAddress().getPort())
          .build();
      client.getSupported();
    } finally {
      server.stop(0);
    }
    assertThat(upgrades).containsExactly("<none>");
  }

  @Test
  void aUrlWithUserInfoIsRefusedWithoutRepeatingTheSecret() {
    assertThatThrownBy(() -> HttpFacilitatorClient.builder()
        .url("https://alice:s3cret@facilitator.example").build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("credentials")
        .hasMessageContaining("FacilitatorAuthProvider")
        .hasMessageNotContaining("s3cret")
        .hasMessageNotContaining("alice");
  }

  @Test
  void aUrlWithAQueryOrFragmentIsRefused() {
    assertThatThrownBy(() -> HttpFacilitatorClient.builder()
        .url("https://facilitator.example/x402?apiKey=k3y").build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("query or fragment")
        .hasMessageNotContaining("k3y");
    assertThatThrownBy(() -> HttpFacilitatorClient.builder()
        .url("https://facilitator.example/x402#token").build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("query or fragment");
  }

  @Test
  void aMalformedUrlCarryingCredentialsOrAKeyIsRefusedToo() {
    assertThatThrownBy(() -> HttpFacilitatorClient.builder()
        .url("https://alice:s3cret@facilitator.example/x 402").build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("credentials")
        .hasMessageNotContaining("s3cret");
    assertThatThrownBy(() -> HttpFacilitatorClient.builder()
        .url("https://facilitator.example/x402?key=k|3y").build())
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("query or fragment")
        .hasMessageNotContaining("k|3y");
    assertThat(HttpFacilitatorClient.builder().url("https://facilitator.example/x 402").build())
        .isNotNull();
  }

  @Test
  void aBareUrlStillBuilds() {
    assertThat(HttpFacilitatorClient.builder().url("https://facilitator.example/x402/").build())
        .isNotNull();
    assertThat(HttpFacilitatorClient.builder().build()).isNotNull();
  }
}
