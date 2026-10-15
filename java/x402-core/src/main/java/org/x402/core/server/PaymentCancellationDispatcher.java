package org.x402.core.server;

import org.x402.core.types.SettleResponse;

/**
 * Cancels a verified payment whose handler failed. Only
 * the first call dispatches; later calls return the first result.
 */
@FunctionalInterface
public interface PaymentCancellationDispatcher {

  /**
   * Fires {@code onVerifiedPaymentCanceled} hooks and, when the scheme settles on cancel after a
   * before-handler settle, settles once (errors are returned as a failed result, never thrown).
   *
   * @param options why
   * @return the cancel settle result, or {@code null} when nothing was settled
   */
  SettleResponse cancel(CancelOptions options);
}
