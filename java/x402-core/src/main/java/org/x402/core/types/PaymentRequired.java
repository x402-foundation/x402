package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.List;
import java.util.Map;

/**
 * The body of the {@code PAYMENT-REQUIRED} header.
 *
 * @param x402Version the protocol version, 2
 * @param error optional reason the previous payment was refused
 * @param resource the protected resource
 * @param accepts the payment options, in the provider's order of preference
 * @param extensions optional extension declarations
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"x402Version", "error", "resource", "accepts", "extensions"})
public record PaymentRequired(
    int x402Version,
    String error,
    ResourceInfo resource,
    List<PaymentRequirements> accepts,
    Map<String, Object> extensions) {

  /** Copies the collections. */
  public PaymentRequired {
    accepts = accepts == null ? List.of() : List.copyOf(accepts);
    extensions = Collections2.copyMap(extensions);
  }
}
