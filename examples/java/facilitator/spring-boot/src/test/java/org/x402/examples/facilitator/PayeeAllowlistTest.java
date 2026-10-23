package org.x402.examples.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

/** With {@code example.allowed-pay-to}, a payment to any other address is refused at verify. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
    "BLOCKFROST_PREPROD_PROJECT_ID=preprodExampleTest",
    "BLOCKFROST_PREPROD_URL=http://127.0.0.1:9/api/v0",
    "FACILITATOR_PASSWORD=s3cret",
    "example.allowed-pay-to=addr_test1qourseller"})
class PayeeAllowlistTest {

  @LocalServerPort
  int port;

  private static final String REQUIREMENTS = "{\"scheme\":\"exact\","
      + "\"network\":\"cardano:preprod\",\"asset\":\"lovelace\",\"amount\":\"1000000\","
      + "\"payTo\":\"addr_test1qsomeoneelse\",\"maxTimeoutSeconds\":300,\"extra\":{}}";

  @Test
  void aPaymentToAnotherAddressIsInvalidBeforeTheChainIsAsked() throws Exception {
    HttpResponse<String> response = post("/x402/verify");

    assertThat(response.statusCode()).isEqualTo(200);
    JsonNode verify = new ObjectMapper().readTree(response.body());
    assertThat(verify.path("isValid").asBoolean(true)).isFalse();
    assertThat(verify.path("invalidReason").asText()).isEqualTo("payee_not_allowed");
  }

  /** /settle is reachable without /verify, so it needs the same check. */
  @Test
  void settlingAPaymentToAnotherAddressIsAborted() throws Exception {
    HttpResponse<String> response = post("/x402/settle");

    assertThat(response.statusCode()).isEqualTo(200);
    JsonNode settle = new ObjectMapper().readTree(response.body());
    assertThat(settle.path("success").asBoolean(true)).isFalse();
    assertThat(settle.path("errorReason").asText()).isEqualTo("payee_not_allowed");
    assertThat(settle.path("transaction").asText("x")).isEmpty();
  }

  private HttpResponse<String> post(String path) throws Exception {
    String body = "{\"x402Version\":2,\"paymentPayload\":{\"x402Version\":2,\"accepted\":"
        + REQUIREMENTS + ",\"payload\":{\"transaction\":\"84a400\"}},"
        + "\"paymentRequirements\":" + REQUIREMENTS + "}";
    return HttpClient.newHttpClient().send(HttpRequest.newBuilder(
            URI.create("http://127.0.0.1:" + port + path))
        .header("Content-Type", "application/json")
        .header("Authorization", "Basic " + Base64.getEncoder()
            .encodeToString("x402:s3cret".getBytes(StandardCharsets.UTF_8)))
        .POST(HttpRequest.BodyPublishers.ofString(body)).build(),
        HttpResponse.BodyHandlers.ofString());
  }
}
