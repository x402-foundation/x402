package org.x402.http.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.x402.http.facilitator.FacilitatorTestSupport.PREPROD;
import static org.x402.http.facilitator.FacilitatorTestSupport.bytes;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.x402.core.facilitator.X402Facilitator;
import org.x402.core.json.X402Json;
import org.x402.http.facilitator.FacilitatorTestSupport.RecordingScheme;
import org.x402.http.facilitator.FacilitatorTestSupport.Vectors;

/**
 * Request bodies are parsed with bounds on nesting, string and number length, so a hostile body
 * is a 400 rather than unbounded work. Responses and other parsing keep the shared mapper.
 */
class FacilitatorRequestLimitsTest {

  private final FacilitatorHttpHandler handler = new FacilitatorHttpHandler(
      new X402Facilitator().register(PREPROD, new RecordingScheme()), FacilitatorHttpHandler.DEFAULT_BASE_PATH);

  private FacilitatorHttpResponse verify(String body) {
    return handler.handle("POST", "/x402/verify", bytes(body));
  }

  private static String withExtra(String json) {
    ObjectNode body = (ObjectNode) Vectors.requestJson("verify-valid");
    String text = X402Json.write(body);
    return text.substring(0, text.length() - 1) + ",\"extra\":" + json + "}";
  }

  @Test
  void aValidBodyIsUnaffected() {
    assertThat(verify(withExtra("1")).status()).isEqualTo(200);
  }

  @Test
  void nestingBeyond64LevelsIsABadRequest() {
    assertThat(verify(withExtra("[".repeat(80) + "]".repeat(80))).status()).isEqualTo(400);
  }

  @Test
  void aStringBeyond200000CharactersIsABadRequest() {
    assertThat(verify(withExtra("\"" + "a".repeat(200_001) + "\"")).status()).isEqualTo(400);
  }

  @Test
  void aNumberBeyond1000DigitsIsABadRequest() {
    assertThat(verify(withExtra("1".repeat(1_001))).status()).isEqualTo(400);
  }

  @Test
  void theSharedMapperKeepsItsDefaults() throws Exception {
    assertThat(X402Json.mapper().readTree("[".repeat(80) + "]".repeat(80))).isNotNull();
  }
}
