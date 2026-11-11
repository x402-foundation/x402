package org.x402.http;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A response an adapter must write.
 *
 * @param status the status
 * @param headers headers to set, in order
 * @param body the body: a {@code String} (HTML or text) or a value to serialize as JSON
 * @param html whether the body is HTML
 */
public record HttpResponseInstructions(
    int status, Map<String, String> headers, Object body, boolean html) {

  /** Copies the headers. */
  public HttpResponseInstructions {
    headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
  }
}
