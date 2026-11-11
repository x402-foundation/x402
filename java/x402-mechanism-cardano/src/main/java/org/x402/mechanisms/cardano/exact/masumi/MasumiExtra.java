package org.x402.mechanisms.cardano.exact.masumi;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A schema-validated Masumi {@code extra} block.
 *
 * @param confirmationPolicy the raw {@code confirmationPolicy}, or {@code null} when absent
 * @param areFeesSponsored {@code false} when present, else {@code null}
 * @param inputCommitment the request commitment
 * @param terms the seller-signed terms
 * @param referenceKey CBOR COSE_Key hex
 * @param referenceSignature CBOR COSE_Sign1 hex
 * @param blockchainIdentifier compressed compatibility identifier hex
 * @param deployment a custom deployment, or {@code null}
 */
public record MasumiExtra(
    Object confirmationPolicy,
    Boolean areFeesSponsored,
    MasumiInputCommitment inputCommitment,
    MasumiTerms terms,
    String referenceKey,
    String referenceSignature,
    String blockchainIdentifier,
    MasumiDeployment deployment) {

  /** The method marker. */
  public static final String ASSET_TRANSFER_METHOD = "masumi";

  /**
   * The JSON form in issue order, {@code areFeesSponsored} last as
   * the quote issuer appends it.
   *
   * @return the map
   */
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("assetTransferMethod", ASSET_TRANSFER_METHOD);
    if (confirmationPolicy != null) {
      json.put("confirmationPolicy", confirmationPolicy);
    }
    json.put("inputCommitment", inputCommitment.toJson());
    json.put("terms", terms.toJson());
    json.put("referenceKey", referenceKey);
    json.put("referenceSignature", referenceSignature);
    json.put("blockchainIdentifier", blockchainIdentifier);
    if (deployment != null) {
      json.put("deployment", deployment.toJson());
    }
    if (areFeesSponsored != null) {
      json.put("areFeesSponsored", areFeesSponsored);
    }
    return json;
  }
}
