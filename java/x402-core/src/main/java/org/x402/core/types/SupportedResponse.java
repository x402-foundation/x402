package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A facilitator's {@code /supported} answer.
 *
 * @param kinds supported kinds
 * @param extensions supported extension keys
 * @param signers signer addresses by CAIP family pattern
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"kinds", "extensions", "signers"})
public record SupportedResponse(
    List<SupportedKind> kinds, List<String> extensions, Map<String, List<String>> signers) {

  /** Copies the collections, defaulting to empty. */
  public SupportedResponse {
    kinds = kinds == null ? List.of() : List.copyOf(kinds);
    extensions = extensions == null ? List.of() : List.copyOf(extensions);
    signers =
        signers == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(signers));
  }
}
