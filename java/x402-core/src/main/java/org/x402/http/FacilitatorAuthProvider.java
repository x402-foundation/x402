package org.x402.http;

import java.util.Map;

/**
 * Supplies per-endpoint headers for facilitator calls; called once
 * per request so tokens may rotate.
 */
@FunctionalInterface
public interface FacilitatorAuthProvider {

  /**
   * Creates the headers.
   *
   * @return headers per endpoint
   */
  AuthHeaders createAuthHeaders();

  /**
   * A provider returning fixed headers.
   *
   * @param headers the headers
   * @return the provider
   */
  static FacilitatorAuthProvider of(AuthHeaders headers) {
    return () -> headers;
  }

  /**
   * Headers for each facilitator endpoint.
   *
   * @param verify headers for {@code POST /verify}, may be {@code null}
   * @param settle headers for {@code POST /settle}, may be {@code null}
   * @param supported headers for {@code GET /supported}, may be {@code null}
   */
  record AuthHeaders(
      Map<String, String> verify, Map<String, String> settle, Map<String, String> supported) {

    /** Copies the maps, defaulting to empty. */
    public AuthHeaders {
      verify = verify == null ? Map.of() : Map.copyOf(verify);
      settle = settle == null ? Map.of() : Map.copyOf(settle);
      supported = supported == null ? Map.of() : Map.copyOf(supported);
    }
  }
}
