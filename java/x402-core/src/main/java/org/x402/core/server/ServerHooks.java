package org.x402.core.server;

import java.util.List;
import java.util.Map;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/**
 * Resource-server hook types and their contexts. Hooks
 * run synchronously, in registration order.
 */
public final class ServerHooks {

  private ServerHooks() {}

  /** When a settlement happens relative to the protected handler. */
  public enum SettlePhase {
    /** Settled before the handler ran (upfront / escrow flows). */
    BEFORE_HANDLER("before-handler"),
    /** Settled after a successful handler (authorization flow). */
    AFTER_HANDLER("after-handler"),
    /** Settled while cancelling a verified payment ({@code settleOnCancel}). */
    CANCEL("cancel");

    private final String wire;

    SettlePhase(String wire) {
      this.wire = wire;
    }

    /**
     * The string used on the wire.
     *
     * @return the wire name
     */
    public String wire() {
      return wire;
    }
  }

  /** Why a verified payment was cancelled. */
  public enum CancellationReason {
    /** The handler threw. */
    HANDLER_THREW("handler_threw"),
    /** The handler answered with status ≥ 400. */
    HANDLER_FAILED("handler_failed"),
    /** An after-verify hook aborted. */
    AFTER_VERIFY_ABORTED("after_verify_aborted");

    private final String wire;

    CancellationReason(String wire) {
      this.wire = wire;
    }

    /**
     * The string value.
     *
     * @return the wire name
     */
    public String wire() {
      return wire;
    }
  }

  /**
   * Context of a verify call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the matched requirements
   * @param declaredExtensions extensions declared by the route
   * @param transportContext transport-specific data, e.g. the HTTP request context
   */
  public record VerifyContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext) {}

  /**
   * Context after a verify call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the matched requirements
   * @param declaredExtensions extensions declared by the route
   * @param transportContext transport-specific data
   * @param result the verify result
   */
  public record VerifyResultContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      VerifyResponse result) {}

  /**
   * Context of a failed verify call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the matched requirements
   * @param declaredExtensions extensions declared by the route
   * @param transportContext transport-specific data
   * @param error the failure
   */
  public record VerifyFailureContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      Object transportContext,
      Throwable error) {}

  /**
   * Context of a settle call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the requirements being settled
   * @param declaredExtensions extensions declared by the route
   * @param phase when the settlement happens
   * @param transportContext transport-specific data
   */
  public record SettleContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      SettlePhase phase,
      Object transportContext) {}

  /**
   * Context after a settle call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the requirements being settled
   * @param declaredExtensions extensions declared by the route
   * @param phase when the settlement happened
   * @param transportContext transport-specific data
   * @param result the settle result
   */
  public record SettleResultContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      SettlePhase phase,
      Object transportContext,
      SettleResponse result) {}

  /**
   * Context of a failed settle call.
   *
   * @param paymentPayload the client's payload
   * @param requirements the requirements being settled
   * @param declaredExtensions extensions declared by the route
   * @param phase when the settlement was attempted
   * @param transportContext transport-specific data
   * @param error the failure
   */
  public record SettleFailureContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      SettlePhase phase,
      Object transportContext,
      Throwable error) {}

  /**
   * Context of a cancelled verified payment.
   *
   * @param paymentPayload the client's payload
   * @param requirements the verified requirements
   * @param declaredExtensions extensions declared by the route
   * @param phase the phase the cancellation happens in
   * @param transportContext transport-specific data
   * @param reason why it was cancelled
   * @param error the handler's error, if any
   * @param responseStatus the handler's status, if any
   * @param settledPhases phases already settled for this payment
   */
  public record VerifiedPaymentCanceledContext(
      PaymentPayload paymentPayload,
      PaymentRequirements requirements,
      Map<String, Object> declaredExtensions,
      SettlePhase phase,
      Object transportContext,
      CancellationReason reason,
      Throwable error,
      Integer responseStatus,
      List<SettlePhase> settledPhases) {}

  /** Runs before verify; may abort or substitute a result. */
  @FunctionalInterface
  public interface BeforeVerifyHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return proceed, abort or skip
     */
    BeforeResult<VerifyResponse> apply(VerifyContext context);
  }

  /**
   * Runs after every verify, also when the result is invalid ({@code result().isValid()} is
   * false); may abort or skip the handler.
   */
  @FunctionalInterface
  public interface AfterVerifyHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return proceed, abort or skip the handler
     */
    AfterVerifyResult apply(VerifyResultContext context);
  }

  /** Runs when verify fails; may recover. */
  @FunctionalInterface
  public interface OnVerifyFailureHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return no recovery, or a recovered result
     */
    Recovery<VerifyResponse> apply(VerifyFailureContext context);
  }

  /** Runs before settle; may abort or substitute a result. */
  @FunctionalInterface
  public interface BeforeSettleHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return proceed, abort or skip
     */
    BeforeResult<SettleResponse> apply(SettleContext context);
  }

  /** Runs after a successful settle. */
  @FunctionalInterface
  public interface AfterSettleHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     */
    void apply(SettleResultContext context);
  }

  /** Runs when settle fails; may recover. */
  @FunctionalInterface
  public interface OnSettleFailureHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     * @return no recovery, or a recovered result
     */
    Recovery<SettleResponse> apply(SettleFailureContext context);
  }

  /** Runs when a verified payment is cancelled. */
  @FunctionalInterface
  public interface OnVerifiedPaymentCanceledHook {
    /**
     * Runs the hook.
     *
     * @param context the context
     */
    void apply(VerifiedPaymentCanceledContext context);
  }

  /**
   * Scheme-scoped hooks a server scheme may contribute. They run
   * only for requirements of that scheme, after the server-wide hooks of the same phase.
   *
   * @param onBeforeVerify optional
   * @param onAfterVerify optional
   * @param onBeforeSettle optional
   * @param onAfterSettle optional
   * @param onVerifyFailure optional
   * @param onSettleFailure optional
   * @param onVerifiedPaymentCanceled optional
   */
  public record SchemeServerHooks(
      BeforeVerifyHook onBeforeVerify,
      AfterVerifyHook onAfterVerify,
      BeforeSettleHook onBeforeSettle,
      AfterSettleHook onAfterSettle,
      OnVerifyFailureHook onVerifyFailure,
      OnSettleFailureHook onSettleFailure,
      OnVerifiedPaymentCanceledHook onVerifiedPaymentCanceled) {

    /** No scheme hooks. */
    public static final SchemeServerHooks NONE =
        new SchemeServerHooks(null, null, null, null, null, null, null);
  }
}
