package org.x402.core;

import java.util.Map;
import org.x402.core.client.ClientHooks.SchemeClientHooks;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;

/** The client side of one payment scheme. */
public interface SchemeNetworkClient {

  /**
   * The scheme name.
   *
   * @return the scheme
   */
  String scheme();

  /**
   * Builds and signs a payment for the chosen requirements.
   *
   * @param x402Version the protocol version
   * @param requirements the chosen requirements
   * @param context extensions and the spend cap in force
   * @return the payload and optional extensions
   */
  PaymentPayloadResult createPaymentPayload(
      int x402Version, PaymentRequirements requirements, PaymentPayloadContext context);

  /**
   * Whether this client can pay an option that already matches its scheme and network. The
   * client skips options for which this answers {@code false} (an asset transfer method or an
   * asset the scheme cannot sign, say) and selects among the rest, so it never picks an option it
   * would fail to pay. Java-only; the TypeScript SDK has no equivalent.
   *
   * @param requirements an offered option
   * @return {@code true} when {@link #createPaymentPayload} can handle it; the default accepts
   *     every option
   */
  default boolean supports(PaymentRequirements requirements) {
    return true;
  }

  /**
   * Optional scheme-scoped client hooks.
   *
   * @return the hooks, or {@code null}
   */
  default SchemeClientHooks schemeHooks() {
    return null;
  }

  /**
   * Reverse lookup of a network's default asset, used by spend controls.
   *
   * @param asset the asset in the requirements
   * @param network the network
   * @return the default asset, or {@code null} when it is not one
   */
  default DefaultAsset findDefaultAsset(String asset, String network) {
    return null;
  }

  /**
   * A network's default (USD-pegged) asset.
   *
   * @param asset the asset identifier
   * @param decimals the asset's decimals
   * @param symbol the ticker
   */
  record DefaultAsset(String asset, int decimals, String symbol) {}

  /**
   * Inputs to payment creation.
   *
   * @param extensions client extension data
   * @param maxAmountPerPayment the spend cap in atomic units, if any
   * @param resource the resource the 402 describes, if any (a Masumi quote binds to it)
   */
  record PaymentPayloadContext(
      Map<String, Object> extensions, String maxAmountPerPayment, ResourceInfo resource) {

    /** An empty context. */
    public static final PaymentPayloadContext EMPTY = new PaymentPayloadContext(null, null, null);

    /**
     * A context without the resource.
     *
     * @param extensions client extension data
     * @param maxAmountPerPayment the spend cap in atomic units, if any
     */
    public PaymentPayloadContext(Map<String, Object> extensions, String maxAmountPerPayment) {
      this(extensions, maxAmountPerPayment, null);
    }
  }

  /**
   * The created payment.
   *
   * @param x402Version the protocol version
   * @param payload the scheme payload
   * @param extensions optional extension data
   */
  record PaymentPayloadResult(
      int x402Version, Map<String, Object> payload, Map<String, Object> extensions) {}
}
