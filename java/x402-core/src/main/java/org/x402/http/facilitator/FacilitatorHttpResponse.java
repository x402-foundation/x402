package org.x402.http.facilitator;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * What {@link FacilitatorHttpHandler} answers: an HTTP status and a JSON body. The content type is
 * always {@link #CONTENT_TYPE}; the handler sets no headers (in particular no {@code
 * EXTENSION-RESPONSES}).
 *
 * @param status the HTTP status
 * @param body the JSON body
 */
public record FacilitatorHttpResponse(int status, String body) {

  /** The content type of every body. */
  public static final String CONTENT_TYPE = "application/json";

  /** Requires a body. */
  public FacilitatorHttpResponse {
    Objects.requireNonNull(body, "body");
  }

  /**
   * The body as UTF-8 bytes.
   *
   * @return the bytes
   */
  public byte[] bodyBytes() {
    return body.getBytes(StandardCharsets.UTF_8);
  }
}
