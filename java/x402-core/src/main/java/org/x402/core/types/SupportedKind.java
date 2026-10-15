package org.x402.core.types;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonPropertyOrder;
import java.util.Map;

/**
 * One (version, scheme, network) a facilitator supports.
 *
 * @param x402Version the protocol version
 * @param scheme the scheme
 * @param network the CAIP-2 network or pattern
 * @param extra the facilitator's advertised capabilities for this kind
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
@JsonPropertyOrder({"x402Version", "scheme", "network", "extra"})
public record SupportedKind(int x402Version, String scheme, String network, Map<String, Object> extra) {

  /** Copies {@code extra}. */
  public SupportedKind {
    extra = Collections2.copyMap(extra);
  }
}
