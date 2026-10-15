package org.x402.spring.web;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.x402.core.json.X402Json;
import org.x402.core.server.CancelOptions;
import org.x402.core.server.ServerHooks.CancellationReason;
import org.x402.core.types.SettleResponse;
import org.x402.http.HttpProcessResult;
import org.x402.http.HttpResponseInstructions;
import org.x402.http.X402HttpResourceServer;

/** What the WebMvc and WebFlux filters do alike with a paid request, independent of the stack. */
public final class PaidResponses {

  private PaidResponses() {}

  /**
   * The bytes of a response x402 writes: HTML or a string as is, anything else as JSON.
   *
   * @param instructions the response
   * @return the body bytes
   */
  public static byte[] body(HttpResponseInstructions instructions) {
    return instructions.html() || instructions.body() instanceof String
        ? String.valueOf(instructions.body()).getBytes(StandardCharsets.UTF_8)
        : json(instructions.body() == null ? Map.of() : instructions.body());
  }

  /**
   * A JSON body.
   *
   * @param body the value
   * @return its UTF-8 JSON bytes
   */
  public static byte[] json(Object body) {
    return X402Json.write(body).getBytes(StandardCharsets.UTF_8);
  }

  /**
   * Cancels a verified payment whose handler failed and returns the headers the response must
   * carry ({@code PAYMENT-RESPONSE} for a settlement already made before the handler).
   *
   * @param server the HTTP resource server
   * @param verified the verified payment
   * @param reason why it is cancelled
   * @param error the handler's error, or {@code null}
   * @param status the handler's status, or {@code null}
   * @param cacheControl the response's current {@code Cache-Control}
   * @return the headers to set, or {@code null}
   */
  public static Map<String, String> cancel(X402HttpResourceServer server,
      HttpProcessResult.PaymentVerified verified, CancellationReason reason, Throwable error,
      Integer status, String cacheControl) {
    SettleResponse cancelled = verified.cancellationDispatcher().cancel(
        new CancelOptions(reason, error, status));
    return server.createFailurePathSettlementHeaders(cancelled, verified.beforeHandlerSettlement(),
        verified.paymentPayload(), cacheControl);
  }
}
