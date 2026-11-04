package org.x402.types;

import java.util.Map;

/**
 * A scheme and network combination a facilitator supports.
 *
 * @param x402Version the protocol version
 * @param scheme the payment scheme
 * @param network the CAIP-2 network
 * @param extra optional scheme-specific data
 */
public record SupportedKind(int x402Version, String scheme, String network, Map<String, Object> extra) {

    /** Creates a supported kind, copying {@code extra}. */
    public SupportedKind {
        extra = Immutables.map(extra);
    }
}
