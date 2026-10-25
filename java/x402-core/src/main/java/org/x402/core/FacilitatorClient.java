package org.x402.core;

import java.time.Duration;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.SupportedResponse;
import org.x402.core.types.VerifyResponse;

/**
 * How a resource server reaches a facilitator: over HTTP ({@code
 * HttpFacilitatorClient}) or in process ({@code LocalFacilitatorClient}).
 */
public interface FacilitatorClient {

  /**
   * Verifies a payment.
   *
   * @param payload the client's payload
   * @param requirements the requirements
   * @return the verdict
   * @throws VerifyException when the facilitator answered with an error status and a verdict
   */
  VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements);

  /**
   * Settles a payment.
   *
   * @param payload the client's payload
   * @param requirements the requirements
   * @return the settlement result
   * @throws SettleException when the facilitator answered with an error status and a result
   */
  SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements);

  /**
   * Lists what the facilitator supports.
   *
   * @return the supported kinds, extensions and signers
   */
  SupportedResponse getSupported();

  /**
   * An identifier for logs, health and pins; the URL by default.
   *
   * @return the identifier
   */
  String identifier();

  /**
   * The longest a verify call may take, used for the startup timeout-budget warning. {@link
   * Duration#ZERO} means in-process or unknown.
   *
   * @return the verify timeout
   */
  default Duration verifyTimeout() {
    return Duration.ZERO;
  }

  /**
   * The longest a settle call may take, used for the startup timeout-budget warning. {@link
   * Duration#ZERO} means in-process or unknown.
   *
   * @return the settle timeout
   */
  default Duration settleTimeout() {
    return Duration.ZERO;
  }
}
