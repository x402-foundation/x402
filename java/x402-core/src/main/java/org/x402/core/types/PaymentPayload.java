package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Map;

/**
 * The body of the {@code PAYMENT-SIGNATURE} header.
 *
 * @param x402Version the protocol version, 2
 * @param resource optional resource the payment is for
 * @param accepted the requirements the client chose
 * @param payload scheme-specific signed payload
 * @param extensions optional extension data
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"x402Version", "resource", "accepted", "payload", "extensions"})
public record PaymentPayload(
    int x402Version,
    ResourceInfo resource,
    PaymentRequirements accepted,
    Map<String, Object> payload,
    Map<String, Object> extensions) {

  /** Copies the maps; {@code payload} defaults to an empty map. */
  public PaymentPayload {
    payload = Collections2.copyMapOrEmpty(payload);
    extensions = Collections2.copyMap(extensions);
  }
}
