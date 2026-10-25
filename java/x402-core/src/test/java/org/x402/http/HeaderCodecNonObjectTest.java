package org.x402.http;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** A header whose base64 JSON is not an object is invalid, never a {@code null} result. */
class HeaderCodecNonObjectTest {

  private static String b64(String json) {
    return Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
  }

  @ParameterizedTest
  @ValueSource(strings = {"null", "5", "[]", "\"text\"", "true"})
  void everyDecoderRejectsJsonThatIsNotAnObject(String json) {
    String header = b64(json);
    assertThatThrownBy(() -> HeaderCodec.decodePaymentRequired(header))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> HeaderCodec.decodePaymentSignature(header))
        .isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> HeaderCodec.decodePaymentResponse(header))
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void theNullHeaderFromTheFindingIsRejected() {
    assertThatThrownBy(() -> HeaderCodec.decodePaymentRequired("bnVsbA=="))
        .isInstanceOf(IllegalArgumentException.class);
  }
}
