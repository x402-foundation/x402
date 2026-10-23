package org.x402.mechanisms.cardano.exact.masumi;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Masumi request commitment.
 *
 * @param version literal {@code "1"}
 * @param algorithm literal {@code "sha256"}
 * @param parts ordered parts with unique names
 * @param digest the manifest digest, equal to {@code terms.inputHash}
 */
public record MasumiInputCommitment(String version, String algorithm, List<MasumiCommitmentPart> parts, String digest) {

  /** Copies the parts. */
  public MasumiInputCommitment {
    parts = List.copyOf(parts);
  }

  /**
   * The JSON form, in wire field order.
   *
   * @return the map
   */
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("version", version);
    json.put("algorithm", algorithm);
    List<Object> list = new ArrayList<>();
    for (MasumiCommitmentPart part : parts) {
      list.add(part.toJson());
    }
    json.put("parts", list);
    json.put("digest", digest);
    return json;
  }
}
