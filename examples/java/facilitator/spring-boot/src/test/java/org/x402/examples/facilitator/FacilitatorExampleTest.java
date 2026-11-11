package org.x402.examples.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * The example facilitator starts from its YAML and answers {@code /supported}; {@code /verify}
 * and {@code /settle} need HTTP Basic and are exempt from CSRF. The Blockfrost URL points at a
 * closed local port, so nothing here can reach a chain.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "BLOCKFROST_PREPROD_PROJECT_ID=preprodExampleTest",
    "BLOCKFROST_PREPROD_URL=http://127.0.0.1:9/api/v0",
    "FACILITATOR_PASSWORD=s3cret",
    "FACILITATOR_MNEMONIC=abandon abandon abandon abandon abandon abandon abandon abandon "
        + "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
        + "abandon abandon abandon abandon abandon art"})
class FacilitatorExampleTest {

  private static final String BASIC = "Basic "
      + Base64.getEncoder().encodeToString("x402:s3cret".getBytes(StandardCharsets.UTF_8));

  @LocalServerPort
  int port;

  private final HttpClient http = HttpClient.newHttpClient();
  private final ObjectMapper json = new ObjectMapper();

  @Test
  void supportedListsCardanoPreprodWithEveryTransferMethodAndNeedsNoLogin() throws Exception {
    HttpResponse<String> response = send("GET", "/x402/supported", null, null);
    assertThat(response.statusCode()).isEqualTo(200);
    JsonNode body = json.readTree(response.body());
    JsonNode kind = body.path("kinds").get(0);
    assertThat(kind.path("x402Version").asInt()).isEqualTo(2);
    assertThat(kind.path("scheme").asText()).isEqualTo("exact");
    assertThat(kind.path("network").asText()).isEqualTo("cardano:preprod");
    List<String> methods = new ArrayList<>();
    kind.path("extra").path("assetTransferMethods").forEach(m -> methods.add(m.asText()));
    assertThat(methods).containsExactlyInAnyOrder("default", "masumi", "script");
    assertThat(kind.path("extra").path("areFeesSponsored").asBoolean(true)).isFalse();
    assertThat(body.path("signers").toString()).contains("addr_test1");
  }

  @Test
  void settleWithoutCredentialsIs401() throws Exception {
    assertThat(send("POST", "/x402/settle", "{}", null).statusCode()).isEqualTo(401);
    assertThat(send("POST", "/x402/verify", "{}", null).statusCode()).isEqualTo(401);
  }

  @Test
  void anAuthenticatedPostReachesTheFacilitatorWithoutACsrfToken() throws Exception {
    HttpResponse<String> response = send("POST", "/x402/verify", "{}", BASIC);
    assertThat(response.statusCode()).isEqualTo(400);
    assertThat(response.body()).contains("error");
  }

  @Test
  void everythingElseIsDenied() throws Exception {
    assertThat(send("GET", "/actuator", null, BASIC).statusCode()).isIn(403, 404);
    assertThat(send("GET", "/", null, null).statusCode()).isIn(401, 403);
  }

  /** Without a usable password the facilitator must not start (no literal "${...}" password). */
  @Test
  void withoutAPasswordTheFacilitatorDoesNotStart() {
    assertThatThrownBy(() -> startWithPassword(null)).hasStackTraceContaining("FACILITATOR_PASSWORD");
  }

  @ParameterizedTest
  @ValueSource(strings = {"", "   ", "${FACILITATOR_PASSWORD}"})
  void aBlankOrPlaceholderPasswordIsRefused(String password) {
    assertThatThrownBy(() -> startWithPassword(password))
        .hasStackTraceContaining("FACILITATOR_PASSWORD");
  }

  private static void startWithPassword(String password) {
    java.util.List<String> args = new ArrayList<>(List.of("--server.port=0",
        "--BLOCKFROST_PREPROD_PROJECT_ID=preprodExampleTest",
        "--BLOCKFROST_PREPROD_URL=http://127.0.0.1:9/api/v0"));
    if (password != null) {
      args.add("--FACILITATOR_PASSWORD=" + password);
    }
    new SpringApplicationBuilder(FacilitatorApplication.class).run(args.toArray(String[]::new))
        .close();
  }

  private HttpResponse<String> send(String method, String path, String body, String auth)
      throws Exception {
    HttpRequest.Builder request = HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + path))
        .header("Content-Type", "application/json")
        .method(method, body == null ? HttpRequest.BodyPublishers.noBody()
            : HttpRequest.BodyPublishers.ofString(body));
    if (auth != null) {
      request.header("Authorization", auth);
    }
    return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
  }
}
