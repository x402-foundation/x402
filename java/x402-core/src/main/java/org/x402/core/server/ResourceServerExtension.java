package org.x402.core.server;

import java.util.List;
import org.x402.core.SchemeNetworkServer.PaymentRequiredContext;
import org.x402.core.hooks.HookResults.AfterVerifyResult;
import org.x402.core.hooks.HookResults.BeforeResult;
import org.x402.core.hooks.HookResults.Recovery;
import org.x402.core.server.ServerHooks.SettleContext;
import org.x402.core.server.ServerHooks.SettleFailureContext;
import org.x402.core.server.ServerHooks.SettleResultContext;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.server.ServerHooks.VerifyContext;
import org.x402.core.server.ServerHooks.VerifyFailureContext;
import org.x402.core.server.ServerHooks.VerifyResultContext;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/**
 * A resource-server extension,
 * e.g. bazaar discovery. Every member except {@link #key()} is optional; the defaults do nothing.
 *
 * <p>The lifecycle hooks ({@code on…}) run only for requests whose route declares the extension's
 * key, after the server-wide and scheme hooks of the same phase, and receive that declaration.
 * An extension cannot edit {@code accepts}: the wire records are immutable, so
 * {@code enrichPaymentRequiredResponse} only returns the extension's own data.
 */
public interface ResourceServerExtension {

  /**
   * The extension key, as used in route {@code extensions} and {@code PaymentRequired.extensions}.
   *
   * @return the key
   */
  String key();

  /**
   * Fields under the extension's {@code info} that are regenerated per 402 and therefore excluded
   * from client echo validation.
   *
   * @return the field names
   */
  default List<String> dynamicInfoFields() {
    return List.of();
  }

  /**
   * Rewrites the route's declaration per request.
   *
   * @param declaration the route's declaration
   * @param transportContext transport data, e.g. the HTTP request context
   * @return the enriched declaration
   */
  default Object enrichDeclaration(Object declaration, Object transportContext) {
    return declaration;
  }

  /**
   * Data merged into {@code PaymentRequired.extensions[key]}.
   *
   * @param declaration the (enriched) declaration
   * @param context the 402 being built
   * @return the data, or {@code null} to add nothing
   */
  default Object enrichPaymentRequiredResponse(Object declaration, PaymentRequiredContext context) {
    return null;
  }

  /**
   * Data merged into {@code SettleResponse.extensions[key]}; the facilitator's fields stay as they
   * are.
   *
   * @param declaration the declaration
   * @param context the settle result
   * @return the data, or {@code null} to add nothing
   */
  default Object enrichSettlementResponse(Object declaration, SettleResultContext context) {
    return null;
  }

  /**
   * Before verify; may abort or skip.
   *
   * @param declaration the declaration
   * @param context the context
   * @return proceed, abort or skip
   */
  default BeforeResult<VerifyResponse> onBeforeVerify(Object declaration, VerifyContext context) {
    return BeforeResult.proceed();
  }

  /**
   * After a verify result; may abort or skip the handler.
   *
   * @param declaration the declaration
   * @param context the context
   * @return proceed, abort or skip the handler
   */
  default AfterVerifyResult onAfterVerify(Object declaration, VerifyResultContext context) {
    return AfterVerifyResult.proceed();
  }

  /**
   * When verify failed; may recover.
   *
   * @param declaration the declaration
   * @param context the context
   * @return no recovery or a result
   */
  default Recovery<VerifyResponse> onVerifyFailure(
      Object declaration, VerifyFailureContext context) {
    return Recovery.none();
  }

  /**
   * Before settle; may abort or skip.
   *
   * @param declaration the declaration
   * @param context the context
   * @return proceed, abort or skip
   */
  default BeforeResult<SettleResponse> onBeforeSettle(Object declaration, SettleContext context) {
    return BeforeResult.proceed();
  }

  /**
   * After a successful settle.
   *
   * @param declaration the declaration
   * @param context the context
   */
  default void onAfterSettle(Object declaration, SettleResultContext context) {}

  /**
   * When settle failed; may recover.
   *
   * @param declaration the declaration
   * @param context the context
   * @return no recovery or a result
   */
  default Recovery<SettleResponse> onSettleFailure(
      Object declaration, SettleFailureContext context) {
    return Recovery.none();
  }

  /**
   * When a verified payment is cancelled.
   *
   * @param declaration the declaration
   * @param context the context
   */
  default void onVerifiedPaymentCanceled(
      Object declaration, VerifiedPaymentCanceledContext context) {}
}
