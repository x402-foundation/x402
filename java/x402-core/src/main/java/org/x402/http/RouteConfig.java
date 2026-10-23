package org.x402.http;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A protected route plus the {@code failover} flag.
 *
 * @param accepts the payment options, in the provider's order of preference
 * @param resource the resource URL, or {@code null} for the request URL
 * @param description the description
 * @param mimeType the response MIME type
 * @param serviceName the service name
 * @param tags discovery tags
 * @param iconUrl the icon URL
 * @param customPaywallHtml a fixed paywall page for browsers
 * @param unpaidResponseBody the unpaid 402 body for non-browser clients
 * @param settlementFailedResponseBody the 402 body after a failed settlement
 * @param extensions extension declarations, e.g. {@code bazaar}
 * @param failover whether unpinned options may fail over verify to another facilitator
 */
public record RouteConfig(
    List<PaymentOption> accepts,
    String resource,
    String description,
    String mimeType,
    String serviceName,
    List<String> tags,
    String iconUrl,
    String customPaywallHtml,
    UnpaidResponseBody unpaidResponseBody,
    SettlementFailedResponseBody settlementFailedResponseBody,
    Map<String, Object> extensions,
    boolean failover) {

  /** Copies the collections. */
  public RouteConfig {
    accepts = accepts == null ? List.of() : List.copyOf(accepts);
    tags = tags == null ? null : List.copyOf(tags);
    extensions = extensions == null ? null
        : Collections.unmodifiableMap(new LinkedHashMap<>(extensions));
  }

  /**
   * Starts a builder.
   *
   * @return the builder
   */
  public static Builder builder() {
    return new Builder();
  }

  /** Builds a {@link RouteConfig}. */
  public static final class Builder {
    private List<PaymentOption> accepts = List.of();
    private String resource;
    private String description;
    private String mimeType;
    private String serviceName;
    private List<String> tags;
    private String iconUrl;
    private String customPaywallHtml;
    private UnpaidResponseBody unpaidResponseBody;
    private SettlementFailedResponseBody settlementFailedResponseBody;
    private Map<String, Object> extensions;
    private boolean failover;

    private Builder() {}

    /**
     * Sets the payment options.
     *
     * @param value the options
     * @return this builder
     */
    public Builder accepts(List<PaymentOption> value) {
      this.accepts = value;
      return this;
    }

    /**
     * Sets the resource URL.
     *
     * @param value the URL
     * @return this builder
     */
    public Builder resource(String value) {
      this.resource = value;
      return this;
    }

    /**
     * Sets the description.
     *
     * @param value the description
     * @return this builder
     */
    public Builder description(String value) {
      this.description = value;
      return this;
    }

    /**
     * Sets the MIME type.
     *
     * @param value the MIME type
     * @return this builder
     */
    public Builder mimeType(String value) {
      this.mimeType = value;
      return this;
    }

    /**
     * Sets the service name.
     *
     * @param value the name
     * @return this builder
     */
    public Builder serviceName(String value) {
      this.serviceName = value;
      return this;
    }

    /**
     * Sets discovery tags.
     *
     * @param value the tags
     * @return this builder
     */
    public Builder tags(List<String> value) {
      this.tags = value;
      return this;
    }

    /**
     * Sets the icon URL.
     *
     * @param value the URL
     * @return this builder
     */
    public Builder iconUrl(String value) {
      this.iconUrl = value;
      return this;
    }

    /**
     * Sets a fixed paywall page.
     *
     * @param value the HTML
     * @return this builder
     */
    public Builder customPaywallHtml(String value) {
      this.customPaywallHtml = value;
      return this;
    }

    /**
     * Sets the unpaid response body.
     *
     * @param value the body factory
     * @return this builder
     */
    public Builder unpaidResponseBody(UnpaidResponseBody value) {
      this.unpaidResponseBody = value;
      return this;
    }

    /**
     * Sets the settlement-failure response body.
     *
     * @param value the body factory
     * @return this builder
     */
    public Builder settlementFailedResponseBody(SettlementFailedResponseBody value) {
      this.settlementFailedResponseBody = value;
      return this;
    }

    /**
     * Sets extension declarations.
     *
     * @param value the declarations
     * @return this builder
     */
    public Builder extensions(Map<String, Object> value) {
      this.extensions = value;
      return this;
    }

    /**
     * Enables verify failover for unpinned options.
     *
     * @param value whether to fail over
     * @return this builder
     */
    public Builder failover(boolean value) {
      this.failover = value;
      return this;
    }

    /**
     * Builds the route.
     *
     * @return the route
     */
    public RouteConfig build() {
      return new RouteConfig(accepts, resource, description, mimeType, serviceName, tags,
          iconUrl, customPaywallHtml, unpaidResponseBody, settlementFailedResponseBody,
          extensions, failover);
    }
  }
}
