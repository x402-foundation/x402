package org.x402.mechanisms.cardano.exact.masumi;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The seller-signed terms, a closed object.
 *
 * @param version literal {@code "1"}
 * @param paymentType literal {@code Web3CardanoV2}
 * @param sellerAddress key-credential seller address
 * @param sellerReturnAddress optional payout address, {@code null} when omitted
 * @param sellerNonce 32 random bytes as hex
 * @param buyerNonce empty or 7–13 bytes as hex
 * @param agentIdentifierPresent whether {@code agentIdentifier} is on the wire (absent, {@code
 *     null} and empty are distinct signed values)
 * @param agentIdentifier the registry asset id, may be {@code null} when present
 * @param inputHash equal to {@code inputCommitment.digest}
 * @param payByTime POSIX ms
 * @param submitResultTime POSIX ms
 * @param unlockTime POSIX ms
 * @param externalDisputeUnlockTime POSIX ms
 */
public record MasumiTerms(
    String version,
    String paymentType,
    String sellerAddress,
    String sellerReturnAddress,
    String sellerNonce,
    String buyerNonce,
    boolean agentIdentifierPresent,
    String agentIdentifier,
    String inputHash,
    String payByTime,
    String submitResultTime,
    String unlockTime,
    String externalDisputeUnlockTime) {

  /**
   * {@code agentIdentifier} as the datum and identifier see it: a string, else empty.
   *
   * @return the identifier or {@code ""}
   */
  public String agentIdentifierOrEmpty() {
    return agentIdentifier == null ? "" : agentIdentifier;
  }

  /**
   * The JSON form, in wire field order.
   *
   * @return the map
   */
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("version", version);
    json.put("paymentType", paymentType);
    json.put("sellerAddress", sellerAddress);
    if (sellerReturnAddress != null) {
      json.put("sellerReturnAddress", sellerReturnAddress);
    }
    json.put("sellerNonce", sellerNonce);
    json.put("buyerNonce", buyerNonce);
    if (agentIdentifierPresent) {
      json.put("agentIdentifier", agentIdentifier);
    }
    json.put("inputHash", inputHash);
    json.put("payByTime", payByTime);
    json.put("submitResultTime", submitResultTime);
    json.put("unlockTime", unlockTime);
    json.put("externalDisputeUnlockTime", externalDisputeUnlockTime);
    return json;
  }
}
