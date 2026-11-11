package org.x402.mechanisms.cardano.exact.masumi;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Validator parameters baked into the escrow script hash. Admin
 * key order and duplicates are preserved: a repeated key carries repeated voting weight.
 *
 * @param requiredAdmins positive canonical decimal string
 * @param adminVkeys ordered 28-byte lowercase hex key hashes
 * @param cooldownPeriod non-negative canonical decimal string (POSIX ms)
 */
public record MasumiDeployment(String requiredAdmins, List<String> adminVkeys, String cooldownPeriod) {

  /** The canonical deployment for mainnet and preprod; Preview has none. */
  public static final MasumiDeployment DEFAULT =
      new MasumiDeployment(
          "2",
          List.of(
              "fc16a1fcf309aed03ec18bb2176f5ea29acea70bb79145ebaffa8e75",
              "7f78161369549d8e2b138fee724c9fa606d6107a66720bdb4c48ada6",
              "89eef9ea84e0ee7fe4921fa93eb2873ff6e34473f751d5d52cb75aa6"),
          "420000");

  /** Copies the key list. */
  public MasumiDeployment {
    adminVkeys = List.copyOf(adminVkeys);
  }

  /**
   * The JSON form, in wire field order.
   *
   * @return the map
   */
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("requiredAdmins", requiredAdmins);
    json.put("adminVkeys", adminVkeys);
    json.put("cooldownPeriod", cooldownPeriod);
    return json;
  }

  /**
   * Reads a deployment from a JSON map (already schema-validated or trusted configuration).
   *
   * @param json the map
   * @return the deployment
   */
  @SuppressWarnings("unchecked")
  public static MasumiDeployment fromJson(Map<String, ?> json) {
    return new MasumiDeployment(
        (String) json.get("requiredAdmins"),
        (List<String>) json.get("adminVkeys"),
        (String) json.get("cooldownPeriod"));
  }
}
