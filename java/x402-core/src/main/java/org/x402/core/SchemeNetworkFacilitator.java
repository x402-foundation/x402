package org.x402.core;

import java.util.List;
import java.util.Map;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;

/** The facilitator side of one payment scheme. */
public interface SchemeNetworkFacilitator {

  /**
   * The scheme name.
   *
   * @return the scheme
   */
  String scheme();

  /**
   * The CAIP family pattern, e.g. {@code cardano:*}; signers are grouped by it in {@code
   * /supported}.
   *
   * @return the family pattern
   */
  String caipFamily();

  /**
   * Capabilities advertised for a network in {@code /supported}.
   *
   * @param network the network
   * @return the extra map, or {@code null}
   */
  Map<String, Object> getExtra(String network);

  /**
   * Facilitator addresses for a network.
   *
   * @param network the network
   * @return the addresses, possibly empty
   */
  List<String> getSigners(String network);

  /**
   * Verifies a payment without broadcasting it.
   *
   * @param payload the client's payload
   * @param requirements the requirements
   * @param context access to registered extensions
   * @return the verdict
   */
  VerifyResponse verify(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context);

  /**
   * Settles a verified payment.
   *
   * @param payload the client's payload
   * @param requirements the requirements
   * @param context access to registered extensions
   * @return the settlement result
   */
  SettleResponse settle(
      PaymentPayload payload, PaymentRequirements requirements, FacilitatorContext context);
}
