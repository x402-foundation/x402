package org.x402.core.server;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.utils.JsonValues;

/**
 * Mutation policies for scheme enrichment hooks. Violations
 * throw {@link IllegalStateException}.
 */
final class HookPolicy {

  private static final List<String> RESERVED = List.of("paymentFlow", "assetTransferMethod");

  private HookPolicy() {}

  /**
   * A scheme may only add {@code extra}
   * keys, and only to its own accepts.
   *
   * @param baseline the accepts before the hook
   * @param current the accepts after the hook
   * @param scheme the enriching scheme
   * @param network the network of the accept that triggered the hook
   */
  static void assertAdditiveExtraAfterSchemeEnrich(
      List<PaymentRequirements> baseline,
      List<PaymentRequirements> current,
      String scheme,
      String network) {
    String prefix = "[x402] scheme \"" + scheme + "\" violated accepts mutation policy: ";
    if (baseline.size() != current.size()) {
      throw new IllegalStateException(prefix + "accepts length changed (" + baseline.size()
          + " → " + current.size() + ")");
    }
    for (int i = 0; i < baseline.size(); i++) {
      PaymentRequirements b = baseline.get(i);
      PaymentRequirements c = current.get(i);
      boolean matching = b.scheme().equals(scheme) && b.network().equals(network);
      if (!b.scheme().equals(c.scheme()) || !b.network().equals(c.network())) {
        throw new IllegalStateException(prefix + "scheme/network are immutable (index " + i + ")");
      }
      if (b.maxTimeoutSeconds() != c.maxTimeoutSeconds() || !eq(b.payTo(), c.payTo())
          || !eq(b.amount(), c.amount()) || !eq(b.asset(), c.asset())) {
        throw new IllegalStateException(prefix + "payment terms are immutable (index " + i + ")");
      }
      for (Map.Entry<String, Object> e : b.extra().entrySet()) {
        if (!c.extra().containsKey(e.getKey())) {
          throw new IllegalStateException(prefix + "extra[\"" + e.getKey()
              + "\"] was removed (index " + i + ")");
        }
        if (!JsonValues.deepEqual(c.extra().get(e.getKey()), e.getValue())) {
          throw new IllegalStateException(prefix + "extra[\"" + e.getKey()
              + "\"] may not be changed (index " + i + ")");
        }
      }
      if (!matching && c.extra().size() != b.extra().size()) {
        throw new IllegalStateException(prefix
            + "only matching accepts may receive new extra fields (index " + i + ")");
      }
      for (String key : RESERVED) {
        if (b.extra().containsKey(key) != c.extra().containsKey(key)) {
          throw new IllegalStateException(prefix + "extra[\"" + key
              + "\"] is protocol-reserved and immutable during enrichment (index " + i + ")");
        }
      }
    }
  }

  /**
   * Settle-payload enrichment may only add keys.
   *
   * @param payload the client payload
   * @param enrichment the scheme's additions
   * @param label the caller label
   */
  static void assertAdditivePayloadEnrichment(
      Map<String, Object> payload, Map<String, Object> enrichment, String label) {
    for (String key : enrichment.keySet()) {
      if (payload.containsKey(key)) {
        throw new IllegalStateException("[x402] " + label + " violated settlement payload "
            + "enrichment policy: \"" + key + "\" already exists on the client payload");
      }
    }
  }

  /**
   * Response enrichment may only add keys, recursing
   * into objects present on both sides.
   *
   * @param target the settlement {@code extra}
   * @param enrichment the scheme's additions
   * @param label the caller label
   */
  static void assertAdditiveSettlementExtra(
      Map<String, Object> target, Map<String, Object> enrichment, String label) {
    assertAdditive(target, enrichment, label, "extra");
  }

  @SuppressWarnings("unchecked")
  private static void assertAdditive(
      Map<String, Object> target, Map<String, Object> enrichment, String label, String path) {
    for (Map.Entry<String, Object> e : enrichment.entrySet()) {
      String next = path + "[\"" + e.getKey() + "\"]";
      if (!target.containsKey(e.getKey())) {
        continue;
      }
      Object existing = target.get(e.getKey());
      if (existing instanceof Map && e.getValue() instanceof Map) {
        assertAdditive((Map<String, Object>) existing, (Map<String, Object>) e.getValue(), label,
            next);
        continue;
      }
      throw new IllegalStateException("[x402] " + label + " violated settlement response "
          + "enrichment policy: " + next + " already exists on the settlement result");
    }
  }

  /**
   * Deep-merges objects, otherwise the enrichment wins.
   *
   * @param target the settlement {@code extra}
   * @param enrichment the additions
   * @return the merged map
   */
  @SuppressWarnings("unchecked")
  static Map<String, Object> mergeAdditive(
      Map<String, Object> target, Map<String, Object> enrichment) {
    Map<String, Object> merged = new LinkedHashMap<>(target);
    for (Map.Entry<String, Object> e : enrichment.entrySet()) {
      Object existing = merged.get(e.getKey());
      if (existing instanceof Map && e.getValue() instanceof Map) {
        merged.put(e.getKey(), mergeAdditive((Map<String, Object>) existing,
            (Map<String, Object>) e.getValue()));
      } else {
        merged.put(e.getKey(), e.getValue());
      }
    }
    return merged;
  }

  private static boolean eq(Object a, Object b) {
    return a == null ? b == null : a.equals(b);
  }
}
