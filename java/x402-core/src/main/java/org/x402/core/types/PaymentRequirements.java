package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * One acceptable way to pay.
 *
 * @param scheme the payment scheme, e.g. {@code exact}
 * @param network the CAIP-2 network, e.g. {@code cardano:preprod}
 * @param asset the asset identifier in atomic units
 * @param amount the amount in atomic units
 * @param payTo the receiving address
 * @param maxTimeoutSeconds how long the payment may take
 * @param extra scheme-specific data; never {@code null} on the wire
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"scheme", "network", "asset", "amount", "payTo", "maxTimeoutSeconds", "extra"})
public record PaymentRequirements(
    String scheme,
    String network,
    String asset,
    String amount,
    String payTo,
    int maxTimeoutSeconds,
    Map<String, Object> extra) {

  /** Copies {@code extra}, defaulting to an empty map. */
  public PaymentRequirements {
    extra = Collections2.copyMapOrEmpty(extra);
  }

  /**
   * Returns a copy with {@code extra} replaced.
   *
   * @param newExtra the new extra map
   * @return the copy
   */
  public PaymentRequirements withExtra(Map<String, ?> newExtra) {
    return new PaymentRequirements(
        scheme, network, asset, amount, payTo, maxTimeoutSeconds, Collections2.copyMap(newExtra));
  }

  /**
   * Returns a copy with one {@code extra} key set, keeping key order.
   *
   * @param key the key
   * @param value the value
   * @return the copy
   */
  public PaymentRequirements withExtra(String key, Object value) {
    Map<String, Object> next = new LinkedHashMap<>(extra);
    next.put(Objects.requireNonNull(key, "key"), value);
    return withExtra(next);
  }

  /**
   * Returns a copy with another amount.
   *
   * @param newAmount the amount in atomic units
   * @return the copy
   */
  public PaymentRequirements withAmount(String newAmount) {
    return new PaymentRequirements(
        scheme, network, asset, newAmount, payTo, maxTimeoutSeconds, extra);
  }

  /**
   * Returns a copy with another receiver.
   *
   * @param newPayTo the receiving address
   * @return the copy
   */
  public PaymentRequirements withPayTo(String newPayTo) {
    return new PaymentRequirements(
        scheme, network, asset, amount, newPayTo, maxTimeoutSeconds, extra);
  }
}
