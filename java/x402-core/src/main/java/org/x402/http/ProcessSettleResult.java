package org.x402.http;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/**
 * The outcome of {@link X402HttpResourceServer#processSettlement}.
 */
public sealed interface ProcessSettleResult
    permits ProcessSettleResult.Success, ProcessSettleResult.Failure {

  /**
   * The settlement result.
   *
   * @return the result
   */
  SettleResponse response();

  /**
   * Headers to add ({@code PAYMENT-RESPONSE}).
   *
   * @return the headers
   */
  Map<String, String> headers();

  /**
   * Settled: add {@link #headers()} and release the handler's response.
   *
   * @param response the result
   * @param headers the headers to add
   * @param requirements the settled requirements
   */
  record Success(SettleResponse response, Map<String, String> headers,
      PaymentRequirements requirements) implements ProcessSettleResult {

    /** Copies the headers. */
    public Success {
      headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    }
  }

  /**
   * Not settled: discard the handler's response and write {@code httpResponse} (402 with {@code
   * PAYMENT-RESPONSE}).
   *
   * @param response the failed result, {@code errorReason} always set
   * @param headers the settlement headers
   * @param httpResponse the response to write
   */
  record Failure(SettleResponse response, Map<String, String> headers,
      HttpResponseInstructions httpResponse) implements ProcessSettleResult {

    /** Copies the headers. */
    public Failure {
      headers = Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    }
  }
}
