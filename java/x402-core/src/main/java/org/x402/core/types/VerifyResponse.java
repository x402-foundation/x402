package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Map;

/**
 * A facilitator's verify answer.
 *
 * @param isValid whether the payment is valid
 * @param invalidReason machine-readable reason when invalid
 * @param invalidMessage human-readable detail when invalid
 * @param payer the payer address, when known
 * @param extensions optional extension data
 * @param extensionResponses server-internal facilitator side channel
 * @param extra scheme-specific data
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({
  "isValid", "invalidReason", "invalidMessage", "payer", "extensions", "extensionResponses", "extra"
})
public record VerifyResponse(
    @JsonProperty("isValid") boolean isValid,
    String invalidReason,
    String invalidMessage,
    String payer,
    Map<String, Object> extensions,
    Map<String, Object> extensionResponses,
    Map<String, Object> extra) {

  /** Copies the maps. */
  public VerifyResponse {
    extensions = Collections2.copyMap(extensions);
    extensionResponses = Collections2.copyMap(extensionResponses);
    extra = Collections2.copyMap(extra);
  }

  /**
   * A valid result.
   *
   * @param payer the payer, may be {@code null}
   * @return the response
   */
  public static VerifyResponse valid(String payer) {
    return new VerifyResponse(true, null, null, payer, null, null, null);
  }

  /**
   * An invalid result.
   *
   * @param reason the machine-readable reason
   * @param message optional detail
   * @return the response
   */
  public static VerifyResponse invalid(String reason, String message) {
    return new VerifyResponse(false, reason, message, null, null, null, null);
  }
}
