package org.x402.mechanisms.cardano.exact.masumi;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One part of the Masumi request commitment.
 *
 * @param name unique non-empty part name
 * @param canonicalization {@code jcs} or {@code raw}
 * @param mediaType optional media type, {@code null} when absent
 * @param hasContent whether {@code content} is on the wire (it may be JSON {@code null})
 * @param content the content when present
 * @param digest lowercase hex SHA-256 of the part bytes
 */
public record MasumiCommitmentPart(
    String name, String canonicalization, String mediaType, boolean hasContent, Object content, String digest) {

  /**
   * The JSON form, in wire field order.
   *
   * @return the map
   */
  public Map<String, Object> toJson() {
    Map<String, Object> json = new LinkedHashMap<>();
    json.put("name", name);
    json.put("canonicalization", canonicalization);
    if (mediaType != null) {
      json.put("mediaType", mediaType);
    }
    if (hasContent) {
      json.put("content", content);
    }
    json.put("digest", digest);
    return json;
  }
}
