package org.x402.spring.offer;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Every resolved offer, in declaration order, plus resolution warnings. */
public final class X402Offers {

  private final Map<String, ResolvedOffer> offers;
  private final List<String> warnings;

  /**
   * Creates the set.
   *
   * @param offers name → offer, in declaration order
   * @param warnings resolution warnings
   */
  public X402Offers(Map<String, ResolvedOffer> offers, List<String> warnings) {
    this.offers = Collections.unmodifiableMap(new LinkedHashMap<>(offers));
    this.warnings = List.copyOf(warnings);
  }

  /**
   * One offer.
   *
   * @param name the name
   * @return the offer, or {@code null}
   */
  public ResolvedOffer offer(String name) {
    return offers.get(name);
  }

  /**
   * All offers.
   *
   * @return name → offer
   */
  public Map<String, ResolvedOffer> offers() {
    return offers;
  }

  /**
   * The offer names.
   *
   * @return the names in declaration order
   */
  public Set<String> names() {
    return offers.keySet();
  }

  /**
   * Whether there is no offer.
   *
   * @return {@code true} when empty
   */
  public boolean isEmpty() {
    return offers.isEmpty();
  }

  /**
   * Warnings (unused accounts).
   *
   * @return the warnings
   */
  public List<String> warnings() {
    return warnings;
  }
}
