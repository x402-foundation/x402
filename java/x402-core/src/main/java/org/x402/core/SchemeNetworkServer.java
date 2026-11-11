package org.x402.core;

import java.util.List;
import java.util.Map;
import org.x402.core.server.ServerHooks.SchemeServerHooks;
import org.x402.core.server.ServerHooks.SettleContext;
import org.x402.core.server.ServerHooks.SettleResultContext;
import org.x402.core.server.ServerHooks.VerifiedPaymentCanceledContext;
import org.x402.core.types.AssetAmount;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequired;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.Price;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SupportedKind;

/**
 * The resource-server side of one payment scheme on a set of networks. Optional members are
 * default methods returning {@code null} or empty.
 */
public interface SchemeNetworkServer {

  /**
   * The scheme name, e.g. {@code exact}.
   *
   * @return the scheme
   */
  String scheme();

  /**
   * The transfer method assumed when requirements carry none, e.g. {@code default}.
   *
   * @return the method
   */
  String defaultAssetTransferMethod();

  /**
   * Payment flows per asset transfer method.
   *
   * @return method → flow config
   */
  Map<String, PaymentFlow.Config> paymentFlows();

  /**
   * Converts a route price into an exact asset amount on a network.
   *
   * @param price the route price
   * @param network the CAIP-2 network
   * @return the asset amount
   * @throws IllegalArgumentException when the price cannot be expressed on this network
   */
  AssetAmount parsePrice(Price price, String network);

  /**
   * Adds facilitator-advertised details to built requirements (e.g. {@code areFeesSponsored}).
   *
   * @param requirements the base requirements
   * @param supportedKind the facilitator's kind for this network
   * @param facilitatorExtensions the facilitator's extension keys
   * @return the enhanced requirements
   */
  PaymentRequirements enhancePaymentRequirements(
      PaymentRequirements requirements,
      SupportedKind supportedKind,
      List<String> facilitatorExtensions);

  /**
   * Optional scheme-scoped hooks.
   *
   * @return the hooks, or {@code null}
   */
  default SchemeServerHooks schemeHooks() {
    return null;
  }

  /**
   * {@code extra} keys regenerated for every 402, excluded when matching a payment.
   *
   * @return the keys
   */
  default List<String> dynamicExtraFields() {
    return List.of();
  }

  /**
   * Checks that a facilitator kind can serve requirements on a network.
   *
   * @param network the network
   * @param supportedKind the facilitator's kind
   * @param facilitatorExtensions the facilitator's extensions
   * @return an error message, or {@code null} when supported
   */
  default String validateFacilitatorSupport(
      String network, SupportedKind supportedKind, List<String> facilitatorExtensions) {
    return null;
  }

  /**
   * Checks that a facilitator kind can serve one configured option, so a mismatch fails at
   * startup instead of on every request. Called by route validation with the option's {@code
   * extra} (its static price's {@code extra} merged below it); {@code optionExtra} is {@code null}
   * when the option is not known (a scheme-wide check) or its price is dynamic, and an
   * implementation then skips every option-dependent check. The default delegates to {@link
   * #validateFacilitatorSupport(String, SupportedKind, List)}.
   *
   * @param network the network
   * @param supportedKind the facilitator's kind
   * @param facilitatorExtensions the facilitator's extensions
   * @param optionExtra the option's {@code extra}, or {@code null} when unknown
   * @return an error message, or {@code null} when supported
   */
  default String validateFacilitatorSupport(String network, SupportedKind supportedKind,
      List<String> facilitatorExtensions, Map<String, Object> optionExtra) {
    return validateFacilitatorSupport(network, supportedKind, facilitatorExtensions);
  }

  /**
   * Checks one configured option on its own, independent of any facilitator: a problem here is a
   * configuration error that no re-sync can heal, so route validation reports it as fatal. Called
   * with the same {@code extra} as {@link #validateFacilitatorSupport(String, SupportedKind, List,
   * Map)}; only for options with a static price. An implementation should leave such problems
   * out of its facilitator check, which is retried while a facilitator is down.
   *
   * @param network the network
   * @param optionExtra the option's {@code extra}
   * @return an error message, or {@code null} when the option is valid
   */
  default String validateOption(String network, Map<String, Object> optionExtra) {
    return null;
  }

  /**
   * Decimals of an asset, for {@code $} settlement overrides.
   *
   * @param asset the asset
   * @param network the network
   * @return the decimals, or {@code null} when unknown
   */
  default Integer getAssetDecimals(String asset, String network) {
    return null;
  }

  /**
   * Rewrites the requirements of a 402 before it is sent (e.g. Masumi quote issuing).
   *
   * @param context the 402 being built
   * @return replacement requirements, or {@code null} to keep them
   */
  default List<PaymentRequirements> enrichPaymentRequiredResponse(
      PaymentRequiredContext context) {
    return null;
  }

  /**
   * Extra payload fields sent to the facilitator's settle.
   *
   * @param context the settle context
   * @return fields to merge, or {@code null}
   */
  default Map<String, Object> enrichSettlementPayload(SettleContext context) {
    return null;
  }

  /**
   * Extra fields merged into the settle response.
   *
   * @param context the settle result context
   * @return fields to merge, or {@code null}
   */
  default Map<String, Object> enrichSettlementResponse(SettleResultContext context) {
    return null;
  }

  /**
   * Requirements to settle when a verified payment is cancelled (e.g. a partial charge).
   *
   * @param context the cancellation
   * @return the requirements to settle, or {@code null} for none
   */
  default PaymentRequirements settleOnCancel(VerifiedPaymentCanceledContext context) {
    return null;
  }

  /**
   * Context handed to {@link #enrichPaymentRequiredResponse}.
   *
   * @param requirements every payment option in the 402 (of all schemes)
   * @param paymentPayload the rejected payload, if any
   * @param resourceInfo the resource
   * @param error the 402's error, if any
   * @param paymentRequiredResponse the full 402
   * @param transportContext transport-specific data
   * @param acceptIndex the index in {@code requirements} of the option this invocation is for, or
   *     {@code -1} when unknown; the hook runs once per option, and only that option's network
   *     may gain {@code extra} fields
   */
  record PaymentRequiredContext(
      List<PaymentRequirements> requirements,
      PaymentPayload paymentPayload,
      ResourceInfo resourceInfo,
      String error,
      PaymentRequired paymentRequiredResponse,
      Object transportContext,
      int acceptIndex) {

    /**
     * A context without the invoking option's index.
     *
     * @param requirements every payment option in the 402 (of all schemes)
     * @param paymentPayload the rejected payload, if any
     * @param resourceInfo the resource
     * @param error the 402's error, if any
     * @param paymentRequiredResponse the full 402
     * @param transportContext transport-specific data
     */
    public PaymentRequiredContext(
        List<PaymentRequirements> requirements,
        PaymentPayload paymentPayload,
        ResourceInfo resourceInfo,
        String error,
        PaymentRequired paymentRequiredResponse,
        Object transportContext) {
      this(requirements, paymentPayload, resourceInfo, error, paymentRequiredResponse,
          transportContext, -1);
    }
  }
}
