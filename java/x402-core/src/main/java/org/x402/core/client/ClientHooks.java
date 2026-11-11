package org.x402.core.client;

import org.x402.core.hooks.HookResults.Decision;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;

/** Client hook types and contexts. */
public final class ClientHooks {

  private ClientHooks() {}

  /**
   * Context of a payment creation.
   *
   * @param paymentRequired the server's 402
   * @param selectedRequirements the option the client chose
   */
  public record PaymentCreationContext(
      PaymentRequired paymentRequired, PaymentRequirements selectedRequirements) {}

  /**
   * Context after a payment was created.
   *
   * @param paymentRequired the server's 402
   * @param selectedRequirements the chosen option
   * @param paymentPayload the created payload
   */
  public record PaymentCreatedContext(
      PaymentRequired paymentRequired,
      PaymentRequirements selectedRequirements,
      PaymentPayload paymentPayload) {}

  /**
   * Context of a failed payment creation.
   *
   * @param paymentRequired the server's 402
   * @param selectedRequirements the chosen option
   * @param error the failure
   */
  public record PaymentCreationFailureContext(
      PaymentRequired paymentRequired, PaymentRequirements selectedRequirements, Throwable error) {}

  /**
   * Context of the server's answer to a paid request.
   *
   * @param paymentPayload the payload that was sent
   * @param requirements the chosen requirements
   * @param settleResponse the decoded {@code PAYMENT-RESPONSE}, if any
   * @param paymentRequired a new 402, if the server answered with one
   * @param error a failure, if any
   */
  public record PaymentResponseContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      SettleResponse settleResponse,
      PaymentRequired paymentRequired,
      Throwable error) {}

  /** Before a payment is created; may abort. */
  @FunctionalInterface
  public interface BeforePaymentCreationHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return proceed or abort
     */
    Decision apply(PaymentCreationContext context);
  }

  /** After a payment was created. */
  @FunctionalInterface
  public interface AfterPaymentCreationHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     */
    void apply(PaymentCreatedContext context);
  }

  /** When payment creation fails; may recover with a payload. */
  @FunctionalInterface
  public interface OnPaymentCreationFailureHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return no recovery or a recovered payload
     */
    Recovery<PaymentPayload> apply(PaymentCreationFailureContext context);
  }

  /** When the server answered a paid request. */
  @FunctionalInterface
  public interface OnPaymentResponseHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return {@code true} if the hook recovered from an error in the context
     */
    boolean apply(PaymentResponseContext context);
  }

  /**
   * Scheme-scoped client hooks.
   *
   * @param onBeforePaymentCreation optional
   * @param onAfterPaymentCreation optional
   * @param onPaymentCreationFailure optional
   * @param onPaymentResponse optional
   */
  public record SchemeClientHooks(
      BeforePaymentCreationHook onBeforePaymentCreation,
      AfterPaymentCreationHook onAfterPaymentCreation,
      OnPaymentCreationFailureHook onPaymentCreationFailure,
      OnPaymentResponseHook onPaymentResponse) {}
}
