package org.x402.core.types;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.x402.core.json.X402Json;
import org.x402.http.HeaderCodec;

/**
 * Byte-level checks of the JSON encoding and the base64 header helpers against vectors exported
 * from the TypeScript SDK.
 */
class WireVectorsTest {

  static JsonNode load(String name) throws IOException {
    try (InputStream in = WireVectorsTest.class.getResourceAsStream("/vectors/" + name)) {
      return X402Json.mapper().readTree(in).get("cases");
    }
  }

  static Stream<Arguments> cases(String file) throws IOException {
    return StreamSupport.stream(load(file).spliterator(), false)
        .map(c -> Arguments.of(c.get("name").asText(), c));
  }

  static Stream<Arguments> paymentRequired() throws IOException {
    return cases("payment-required.json");
  }

  static Stream<Arguments> paymentPayload() throws IOException {
    return cases("payment-payload.json");
  }

  static Stream<Arguments> settleResponse() throws IOException {
    return cases("settle-response.json");
  }

  static Stream<Arguments> verifyResponse() throws IOException {
    return cases("verify-response.json");
  }

  static Stream<Arguments> supportedResponse() throws IOException {
    return cases("supported-response.json");
  }

  private static String json(JsonNode value) throws IOException {
    return X402Json.mapper().writeValueAsString(value);
  }

  private static String decode(String header) {
    return new String(Base64.getDecoder().decode(header), StandardCharsets.UTF_8);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("paymentRequired")
  void paymentRequiredHeaderIsByteIdentical(String name, JsonNode c) throws IOException {
    PaymentRequired value = X402Json.mapper().treeToValue(c.get("value"), PaymentRequired.class);
    String header = c.get("header").asText();

    assertThat(HeaderCodec.encodePaymentRequired(value)).isEqualTo(header);
    assertThat(X402Json.mapper().writeValueAsString(value)).isEqualTo(decode(header));
    assertThat(HeaderCodec.decodePaymentRequired(header)).isEqualTo(value);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("paymentPayload")
  void paymentSignatureHeaderIsByteIdentical(String name, JsonNode c) throws IOException {
    PaymentPayload value = X402Json.mapper().treeToValue(c.get("value"), PaymentPayload.class);
    String header = c.get("header").asText();

    assertThat(HeaderCodec.encodePaymentSignature(value)).isEqualTo(header);
    assertThat(HeaderCodec.decodePaymentSignature(header)).isEqualTo(value);
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("settleResponse")
  void paymentResponseHeaderIsByteIdenticalAndStripsExtensionResponses(String name, JsonNode c)
      throws IOException {
    SettleResponse value = X402Json.mapper().treeToValue(c.get("value"), SettleResponse.class);
    String header = c.get("header").asText();

    assertThat(HeaderCodec.encodePaymentResponse(value)).isEqualTo(header);
    assertThat(decode(header)).doesNotContain("extensionResponses");
    assertThat(HeaderCodec.decodePaymentResponse(header).extensionResponses()).isNull();
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("verifyResponse")
  void verifyResponseJsonIsByteIdentical(String name, JsonNode c) throws IOException {
    VerifyResponse value = X402Json.mapper().treeToValue(c.get("value"), VerifyResponse.class);

    assertThat(X402Json.mapper().writeValueAsString(value)).isEqualTo(c.get("json").asText());
    assertThat(X402Json.mapper().writeValueAsString(value)).isEqualTo(json(c.get("value")));
  }

  @ParameterizedTest(name = "{0}")
  @MethodSource("supportedResponse")
  void supportedResponseJsonIsByteIdentical(String name, JsonNode c) throws IOException {
    SupportedResponse value =
        X402Json.mapper().treeToValue(c.get("value"), SupportedResponse.class);

    assertThat(X402Json.mapper().writeValueAsString(value)).isEqualTo(c.get("json").asText());
  }
}
