package org.x402.spring.offer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import org.x402.core.server.PaymentFlows;

/**
 * A payment option being resolved, as seen by {@link X402OptionContributor}s. The account name
 * never reaches the wire.
 */
public final class OptionDraft {

  private final String offerName;
  private final int optionIndex;
  private final String accountName;
  private final String network;
  private final String scheme;
  private final Map<String, Object> priceExtra;
  private final Map<String, Object> optionExtra;
  private final String inheritedTransferMethod;
  private final Integer maxTimeoutSeconds;
  private String payTo;
  private String payToRef;

  OptionDraft(String offerName, int optionIndex, String accountName, String network, String scheme,
      Map<String, Object> priceExtra, Map<String, Object> optionExtra, String payTo,
      String payToRef, String inheritedTransferMethod, Integer maxTimeoutSeconds) {
    this.offerName = offerName;
    this.optionIndex = optionIndex;
    this.accountName = accountName;
    this.network = network;
    this.scheme = scheme;
    this.priceExtra = priceExtra;
    this.optionExtra = new LinkedHashMap<>(optionExtra);
    this.payTo = payTo;
    this.payToRef = payToRef;
    this.inheritedTransferMethod = inheritedTransferMethod;
    this.maxTimeoutSeconds = maxTimeoutSeconds;
  }

  /**
   * The {@code extra} declared on the account and the option (plus contributions), without the
   * {@code price.extra} layer; a value here beats one from {@code price.extra}.
   *
   * @return an unmodifiable copy
   */
  public Map<String, Object> declaredExtra() {
    return Collections.unmodifiableMap(new LinkedHashMap<>(optionExtra));
  }

  /**
   * The option's payment timeout after precedence (option → account → defaults).
   *
   * @return the timeout in seconds
   */
  public Integer maxTimeoutSeconds() {
    return maxTimeoutSeconds;
  }

  /**
   * The offer name.
   *
   * @return the name
   */
  public String offerName() {
    return offerName;
  }

  /**
   * The option's index in {@code accepts}.
   *
   * @return the index
   */
  public int optionIndex() {
    return optionIndex;
  }

  /**
   * The account the option uses.
   *
   * @return the account name, or {@code null} for an inline option
   */
  public String accountName() {
    return accountName;
  }

  /**
   * The CAIP-2 network.
   *
   * @return the network
   */
  public String network() {
    return network;
  }

  /**
   * The scheme.
   *
   * @return the scheme
   */
  public String scheme() {
    return scheme;
  }

  /**
   * The final {@code extra}: {@code price.extra} ← account ← option ← contributions.
   *
   * @return an unmodifiable copy
   */
  public Map<String, Object> extra() {
    Map<String, Object> merged = new LinkedHashMap<>(priceExtra);
    merged.putAll(optionExtra);
    return Collections.unmodifiableMap(merged);
  }

  /**
   * The static receiver.
   *
   * @return the address, or {@code null}
   */
  public String payTo() {
    return payTo;
  }

  /**
   * The dynamic receiver's bean name.
   *
   * @return the bean name, or {@code null}
   */
  public String payToRef() {
    return payToRef;
  }

  /**
   * Sets a static receiver, replacing any {@code pay-to-ref}.
   *
   * @param address the address
   */
  public void setPayTo(String address) {
    this.payTo = Objects.requireNonNull(address, "address");
    this.payToRef = null;
  }

  /**
   * Adds or replaces an {@code extra} key.
   *
   * @param key the key
   * @param value the value
   * @throws IllegalArgumentException when changing an inherited {@code assetTransferMethod}
   */
  public void putExtra(String key, Object value) {
    Objects.requireNonNull(key, "key");
    if (PaymentFlows.ASSET_TRANSFER_METHOD.equals(key) && inheritedTransferMethod != null
        && !inheritedTransferMethod.equals(value)) {
      throw new IllegalArgumentException("cannot change the assetTransferMethod \""
          + inheritedTransferMethod + "\" inherited from account \"" + accountName + "\"");
    }
    optionExtra.put(key, value);
  }

  Map<String, Object> optionExtra() {
    return optionExtra;
  }
}
