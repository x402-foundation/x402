package org.x402;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;
import org.x402.types.SettleResponse;
import org.x402.types.SupportedResponse;
import org.x402.types.VerifyResponse;

import java.io.IOException;

/**
 * Connection from a resource server to a facilitator, either remote ({@code HttpFacilitatorClient}) or
 * in-process ({@link X402Facilitator}).
 *
 * <p>Implementations must be thread-safe.
 */
public interface FacilitatorClient {

    /**
     * Verifies a payment.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the verification result
     * @throws VerifyException if the facilitator rejects the request with a reason
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     */
    VerifyResponse verify(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException;

    /**
     * Settles a payment.
     *
     * @param payload the payment payload
     * @param requirements the requirements the payment must satisfy
     * @return the settlement result
     * @throws SettleException if the facilitator rejects the request with a reason
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     */
    SettleResponse settle(PaymentPayload payload, PaymentRequirements requirements)
            throws IOException, InterruptedException;

    /**
     * Lists the schemes, networks, extensions and signers the facilitator supports.
     *
     * @return the supported capabilities
     * @throws IOException if the facilitator cannot be reached or returns a malformed response
     * @throws InterruptedException if the calling thread is interrupted
     */
    SupportedResponse supported() throws IOException, InterruptedException;
}
