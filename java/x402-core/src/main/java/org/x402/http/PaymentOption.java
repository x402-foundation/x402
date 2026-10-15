package org.x402.http;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.x402.core.server.ResourceConfig;
import org.x402.core.types.Money;
import org.x402.core.types.Price;

/**
 * One way to pay for a route, plus the optional facilitator pin. The
 * receiver and the price are each either static or resolved per request.
 *
 * @param scheme the scheme, e.g. {@code exact}
 * @param network the CAIP-2 network
 * @param payTo a static receiver, or {@code null} when {@code payToResolver} is set
 * @param payToResolver a per-request receiver, or {@code null}
 * @param price a static price, or {@code null} when {@code priceResolver} is set
 * @param priceResolver a per-request price, or {@code null}
 * @param maxTimeoutSeconds the payment timeout, or {@code null} for 300
 * @param extra scheme-specific data
 * @param facilitator the pinned facilitator identifier, or {@code null}; never on the wire
 */
public record PaymentOption(
    String scheme,
    String network,
    String payTo,
    DynamicPayTo payToResolver,
    Price price,
    DynamicPrice priceResolver,
    Integer maxTimeoutSeconds,
    Map<String, Object> extra,
    String facilitator) {

  /** Validates: one receiver and one price. */
  public PaymentOption {
    Objects.requireNonNull(scheme, "scheme");
    Objects.requireNonNull(network, "network");
    if ((payTo == null) == (payToResolver == null)) {
      throw new IllegalArgumentException("set exactly one of payTo and a payTo resolver");
    }
    if ((price == null) == (priceResolver == null)) {
      throw new IllegalArgumentException("set exactly one of price and a price resolver");
    }
    extra = extra == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(extra));
  }

  /**
   * Starts a builder.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /**
   * Resolves the option for one request.
   *
   * @param context the request
   * @return the core option
   */
  public ResourceConfig resolve(HttpRequestContext context) {
    String receiver = payTo != null ? payTo : payToResolver.resolve(context);
    Price p = price != null ? price : priceResolver.resolve(context);
    return new ResourceConfig(scheme, network, receiver, p, maxTimeoutSeconds, extra, facilitator);
  }

  /**
   * The effective payment timeout.
   *
   * @return the timeout or 300
   */
  public int effectiveMaxTimeoutSeconds() {
    return ResourceConfig.effectiveMaxTimeoutSeconds(maxTimeoutSeconds);
  }

  /** Builds a {@link PaymentOption}. */
  public static final class Builder {
    private String scheme = "exact";
    private String network;
    private String payTo;
    private DynamicPayTo payToResolver;
    private Price price;
    private DynamicPrice priceResolver;
    private Integer maxTimeoutSeconds;
    private Map<String, Object> extra;
    private String facilitator;

    private Builder() {}

    /**
     * Sets the scheme (default {@code exact}).
     *
     * @param value the scheme
     * @return this builder
     */
    public Builder scheme(String value) {
      this.scheme = value;
      return this;
    }

    /**
     * Sets the network.
     *
     * @param value the CAIP-2 network
     * @return this builder
     */
    public Builder network(String value) {
      this.network = value;
      return this;
    }

    /**
     * Sets a static receiver.
     *
     * @param value the address
     * @return this builder
     */
    public Builder payTo(String value) {
      this.payTo = value;
      this.payToResolver = null;
      return this;
    }

    /**
     * Sets a per-request receiver.
     *
     * @param value the resolver
     * @return this builder
     */
    public Builder payTo(DynamicPayTo value) {
      this.payToResolver = value;
      this.payTo = null;
      return this;
    }

    /**
     * Sets a static money price such as {@code "$0.01"}.
     *
     * @param money the money string
     * @return this builder
     */
    public Builder price(String money) {
      return price(new Money(money));
    }

    /**
     * Sets a static price.
     *
     * @param value the price
     * @return this builder
     */
    public Builder price(Price value) {
      this.price = value;
      this.priceResolver = null;
      return this;
    }

    /**
     * Sets a per-request price.
     *
     * @param value the resolver
     * @return this builder
     */
    public Builder price(DynamicPrice value) {
      this.priceResolver = value;
      this.price = null;
      return this;
    }

    /**
     * Sets the payment timeout.
     *
     * @param seconds the timeout
     * @return this builder
     */
    public Builder maxTimeoutSeconds(int seconds) {
      this.maxTimeoutSeconds = seconds;
      return this;
    }

    /**
     * Sets scheme-specific data.
     *
     * @param value the extra map
     * @return this builder
     */
    public Builder extra(Map<String, Object> value) {
      this.extra = value;
      return this;
    }

    /**
     * Pins the option to a facilitator.
     *
     * @param identifier the effective identifier
     * @return this builder
     */
    public Builder facilitator(String identifier) {
      this.facilitator = identifier;
      return this;
    }

    /**
     * Builds the option.
     *
     * @return the option
     */
    public PaymentOption build() {
      return new PaymentOption(scheme, network, payTo, payToResolver, price, priceResolver,
          maxTimeoutSeconds, extra, facilitator);
    }
  }
}
