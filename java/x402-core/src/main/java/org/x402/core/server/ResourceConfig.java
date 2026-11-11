package org.x402.core.server;

import java.util.Map;
import java.util.Objects;
import org.x402.core.types.Price;

/**
 * One resolved payment option of a protected resource, plus the
 * optional facilitator pin.
 *
 * @param scheme the scheme, e.g. {@code exact}
 * @param network the CAIP-2 network
 * @param payTo the receiving address
 * @param price the price
 * @param maxTimeoutSeconds the payment timeout, or {@code null} for the default 300
 * @param extra scheme-specific data, merged over {@code price.extra}
 * @param facilitator the pinned facilitator identifier, or {@code null}; never serialized
 */
public record ResourceConfig(
    String scheme,
    String network,
    String payTo,
    Price price,
    Integer maxTimeoutSeconds,
    Map<String, Object> extra,
    String facilitator) {

  /** The payment timeout used when none is configured, in seconds. */
  public static final int DEFAULT_MAX_TIMEOUT_SECONDS = 300;

  /** Validates. */
  public ResourceConfig {
    Objects.requireNonNull(scheme, "scheme");
    Objects.requireNonNull(network, "network");
    Objects.requireNonNull(price, "price");
  }

  /**
   * Creates an unpinned option with default timeout and no extra.
   *
   * @param scheme the scheme
   * @param network the network
   * @param payTo the receiving address
   * @param price the price
   * @return the option
   */
  public static ResourceConfig of(String scheme, String network, String payTo, Price price) {
    return new ResourceConfig(scheme, network, payTo, price, null, null, null);
  }

  /**
   * Returns a copy pinned to a facilitator.
   *
   * @param identifier the identifier, or {@code null} to unpin
   * @return the copy
   */
  public ResourceConfig withFacilitator(String identifier) {
    return new ResourceConfig(scheme, network, payTo, price, maxTimeoutSeconds, extra, identifier);
  }

  /**
   * The effective payment timeout.
   *
   * @return {@link #maxTimeoutSeconds()} or 300
   */
  public int effectiveMaxTimeoutSeconds() {
    return effectiveMaxTimeoutSeconds(maxTimeoutSeconds);
  }

  /**
   * The rule for an unset timeout: absent or {@code 0} means {@link
   * #DEFAULT_MAX_TIMEOUT_SECONDS}.
   *
   * @param maxTimeoutSeconds the configured timeout, or {@code null}
   * @return the timeout in effect
   */
  public static int effectiveMaxTimeoutSeconds(Integer maxTimeoutSeconds) {
    return maxTimeoutSeconds == null || maxTimeoutSeconds == 0
        ? DEFAULT_MAX_TIMEOUT_SECONDS : maxTimeoutSeconds;
  }
}
