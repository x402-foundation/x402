package org.x402.mechanisms.cardano.exact.facilitator;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/**
 * What a settlement claim is bound to: the payment requirements (without the confirmation policy,
 * so a retry may ask for more depth) and the resource URL. A claim with another binding is a
 * duplicate, so one payment never pays for two resources or two prices.
 *
 * <p>The digest is SHA-256 over canonical JSON {@code {"requirements": {scheme, network, asset,
 * amount, payTo, maxTimeoutSeconds, extra}, "resource": url}}, with map keys sorted at every level
 * and nulls written. It equals the cardano-x402-facilitator's {@code SettlementDigest}, so its
 * journal rows keep their binding after a migration.
 *
 * @param digest the binding a new claim stores
 * @param alternates digests an existing record may carry and still match: the legacy digest
 *     (confirmation policy included), for an empty {@code extra} the digest with {@code "extra":
 *     null}, and for an absent timeout ({@code 0}) the digests with {@code "maxTimeoutSeconds":
 *     null}: the application wrote absent values as null. Never stored.
 */
public record SettlementBinding(String digest, Set<String> alternates) {

  private static final ObjectMapper CANONICAL =
      JsonMapper.builder().configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true).build();

  /** Copies the alternates. */
  public SettlementBinding {
    alternates = alternates == null ? Set.of() : Set.copyOf(alternates);
  }

  /**
   * The binding of a settle request.
   *
   * @param requirements the canonical requirements (never the client-echoed {@code accepted})
   * @param resource the payload's resource, or {@code null}
   * @return the binding
   */
  public static SettlementBinding of(PaymentRequirements requirements, ResourceInfo resource) {
    Set<String> alternates = new LinkedHashSet<>();
    Map<String, Object> withoutPolicy = new LinkedHashMap<>(requirements.extra());
    withoutPolicy.remove("confirmationPolicy");
    // An absent timeout reads as 0 here; the application digested it as null.
    List<Integer> timeouts = requirements.maxTimeoutSeconds() == 0
        ? java.util.Arrays.asList(0, null) : List.of(requirements.maxTimeoutSeconds());
    for (Integer timeout : timeouts) {
      alternates.add(hash(requirements, timeout, withoutPolicy, resource));
      alternates.add(hash(requirements, timeout, requirements.extra(), resource));
      if (requirements.extra().isEmpty()) {
        alternates.add(hash(requirements, timeout, null, resource));
      }
    }
    String digest = digest(requirements, resource);
    alternates.remove(digest);
    return new SettlementBinding(digest, alternates);
  }

  /**
   * The digest a new claim stores: the requirements without {@code extra.confirmationPolicy}.
   *
   * @param requirements the requirements
   * @param resource the resource, or {@code null}
   * @return the lowercase hex digest
   */
  public static String digest(PaymentRequirements requirements, ResourceInfo resource) {
    Map<String, Object> extra = new LinkedHashMap<>(requirements.extra());
    extra.remove("confirmationPolicy");
    return hash(requirements, requirements.maxTimeoutSeconds(), extra, resource);
  }

  /**
   * The legacy digest, with the confirmation policy; only matched, never stored.
   *
   * @param requirements the requirements
   * @param resource the resource, or {@code null}
   * @return the lowercase hex digest
   */
  public static String legacyDigest(PaymentRequirements requirements, ResourceInfo resource) {
    return hash(requirements, requirements.maxTimeoutSeconds(), requirements.extra(), resource);
  }

  /**
   * Whether a stored binding is this one.
   *
   * @param stored the stored digest, or {@code null}
   * @return {@code true} when it equals the digest or an alternate
   */
  public boolean matches(String stored) {
    return stored != null && (stored.equals(digest) || alternates.contains(stored));
  }

  /**
   * The requirements in their wire field order: a record keeps declaration order, while every map
   * (extra) is written with sorted keys.
   */
  record Canonical(String scheme, String network, String asset, String amount, String payTo,
      Integer maxTimeoutSeconds, Map<String, Object> extra) {}

  private static String hash(
      PaymentRequirements r, Integer maxTimeoutSeconds, Map<String, Object> extra, ResourceInfo resource) {
    Map<String, Object> canonical = new LinkedHashMap<>();
    canonical.put("requirements", new Canonical(r.scheme(), r.network(), r.asset(), r.amount(), r.payTo(),
        maxTimeoutSeconds, extra));
    canonical.put("resource", resource == null ? null : resource.url());
    try {
      byte[] json = CANONICAL.writeValueAsString(canonical).getBytes(StandardCharsets.UTF_8);
      return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json));
    } catch (JsonProcessingException | NoSuchAlgorithmException e) {
      throw new IllegalStateException("cannot compute the settlement binding", e);
    }
  }
}
