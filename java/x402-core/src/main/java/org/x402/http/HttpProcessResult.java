package org.x402.http;

import java.util.List;
import java.util.Map;
import org.x402.core.server.CompletedSettlement;
import org.x402.core.server.PaymentCancellationDispatcher;
import org.x402.core.server.SettlementRouting;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;

/**
 * The outcome of {@link X402HttpResourceServer#processHttpRequest}.
 * {@link RouteUnavailable} reports a route that cannot be served as configured.
 */
public sealed interface HttpProcessResult
    permits HttpProcessResult.NoPaymentRequired, HttpProcessResult.PaymentVerified,
        HttpProcessResult.PaymentError, HttpProcessResult.RouteUnavailable {

  /** The request is not protected, or a hook granted access: run the handler as usual. */
  record NoPaymentRequired() implements HttpProcessResult {}

  /**
   * The payment passed the pre-handler gates: run the handler, then follow the adapter contract
   * documented on {@link X402HttpResourceServer}.
   *
   * @param paymentPayload the payment
   * @param paymentRequirements the matched requirements
   * @param declaredExtensions the route's (enriched) extension declarations, may be {@code null}
   * @param beforeHandlerSettlement the settle that ran before the handler (upfront / escrow), or
   *     {@code null}
   * @param cancellationDispatcher cancels the payment when the handler fails
   * @param routing the facilitator route, {@code verifiedBy} and snapshot; settle uses it
   * @param routeKey the matched route's key
   */
  record PaymentVerified(
      PaymentPayload paymentPayload,
      PaymentRequirements paymentRequirements,
      Map<String, Object> declaredExtensions,
      CompletedSettlement beforeHandlerSettlement,
      PaymentCancellationDispatcher cancellationDispatcher,
      SettlementRouting routing,
      String routeKey) implements HttpProcessResult {

    /**
     * The facilitator that verified, or {@code null} when none was called.
     *
     * @return the identifier
     */
    public String verifiedBy() {
      return routing.verifiedBy();
    }
  }

  /**
   * Answer with this response instead of running the handler (402, 403, 412, or 200 after a
   * skip-handler settle).
   *
   * @param response the response to write
   */
  record PaymentError(HttpResponseInstructions response) implements HttpProcessResult {

    /**
     * The status.
     *
     * @return the status
     */
    public int status() {
      return response.status();
    }

    /**
     * The headers.
     *
     * @return the headers
     */
    public Map<String, String> headers() {
      return response.headers();
    }

    /**
     * The body.
     *
     * @return the body
     */
    public Object body() {
      return response.body();
    }

    /**
     * Whether the body is HTML.
     *
     * @return {@code true} for HTML
     */
    public boolean html() {
      return response.html();
    }
  }

  /**
   * The matched route failed validation in the current sync. An adapter
   * answers 503 with {@code Retry-After} when {@code retryable} (a facilitator it might need is
   * down), else 500 {@code {"error": "x402 route configuration"}}.
   *
   * @param route the route key
   * @param errors the route's validation errors
   * @param retryable whether every error may heal with a re-sync
   */
  record RouteUnavailable(String route, List<RouteValidationError> errors, boolean retryable)
      implements HttpProcessResult {

    /** Copies the list. */
    public RouteUnavailable {
      errors = List.copyOf(errors);
    }
  }
}
