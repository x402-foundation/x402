package org.x402.spring.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The facilitator endpoints read at most 256 KB: a larger declared length or a chunked body that
 * grows past the cap gets 413 on both stacks, and a small body still reaches the handler.
 */
class FacilitatorRoutesBodyLimitTest {

  private static final int OVER = 300 * 1024;

  @SpringBootConfiguration
  @EnableAutoConfiguration
  static class App {}

  private static ConfigurableApplicationContext start(String type) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("server.port", "0");
    p.put("spring.main.web-application-type", type);
    p.put("x402.facilitator-server.enabled", "true");
    p.put("x402.facilitator-server.cardano.networks[0].network", "cardano:preprod");
    p.put("x402.facilitator-server.cardano.networks[0].blockfrost.project-id", "k");
    return new SpringApplicationBuilder(App.class).properties(p).run();
  }

  private static int post(ConfigurableApplicationContext ctx, HttpRequest.BodyPublisher body)
      throws IOException, InterruptedException {
    String port = ctx.getEnvironment().getProperty("local.server.port");
    HttpRequest request = HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + "/x402/verify"))
        .header("Content-Type", "application/json").POST(body).build();
    return HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString())
        .statusCode();
  }

  private static byte[] bytes(int length) {
    byte[] b = new byte[length];
    Arrays.fill(b, (byte) 'a');
    return b;
  }

  private static HttpRequest.BodyPublisher chunked(int length) {
    return HttpRequest.BodyPublishers.ofInputStream(
        () -> (InputStream) new ByteArrayInputStream(bytes(length)));
  }

  private void check(String type) throws Exception {
    try (ConfigurableApplicationContext ctx = start(type)) {
      assertThat(post(ctx, HttpRequest.BodyPublishers.ofByteArray(bytes(OVER))))
          .as(type + " content-length over the cap").isEqualTo(413);
      assertThat(post(ctx, chunked(OVER))).as(type + " chunked over the cap").isEqualTo(413);
      assertThat(post(ctx, HttpRequest.BodyPublishers.ofByteArray(bytes(1024))))
          .as(type + " small body reaches the handler").isNotEqualTo(413);
    }
  }

  @Test
  void webMvcRefusesOversizeBodiesWith413() throws Exception {
    check("servlet");
  }

  @Test
  void webFluxRefusesOversizeBodiesWith413() throws Exception {
    check("reactive");
  }
}
