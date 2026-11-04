package org.x402.types;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Response of a facilitator's {@code GET /supported} endpoint.
 *
 * @param kinds the supported scheme and network combinations
 * @param extensions the supported extension ids
 * @param signers facilitator signer addresses keyed by CAIP family, e.g. {@code "eip155:*"}
 */
public record SupportedResponse(
        List<SupportedKind> kinds,
        List<String> extensions,
        Map<String, List<String>> signers) {

    /** Creates a supported response, copying the collections and signer lists and defaulting absent ones to empty. */
    public SupportedResponse {
        kinds = kinds == null ? List.of() : Immutables.list(kinds);
        extensions = extensions == null ? List.of() : Immutables.list(extensions);
        signers = signers == null ? Map.of() : copySigners(signers);
    }

    private static Map<String, List<String>> copySigners(Map<String, List<String>> signers) {
        Map<String, List<String>> copy = new LinkedHashMap<>();
        signers.forEach((family, addresses) -> copy.put(family, Immutables.list(addresses)));
        return Collections.unmodifiableMap(copy);
    }
}
