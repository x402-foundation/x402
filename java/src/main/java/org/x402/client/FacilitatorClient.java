package org.x402.client;

import org.x402.model.PaymentRequirements;

import java.io.IOException;
import java.util.Set;

/** Contract for calling an x402 facilitator (HTTP, gRPC, mock, etc.). */
public interface FacilitatorClient {
    /**
     * Verifies a payment header against the given requirements.
     *
     * @param paymentHeader the X-402 payment header to verify
     * @param req the payment requirements to validate against
     * @return verification response indicating if payment is valid
     * @throws IOException if HTTP request fails or returns non-200 status
     * @throws InterruptedException if the request is interrupted
     */
    VerificationResponse verify(String paymentHeader,
                                PaymentRequirements req)
            throws IOException, InterruptedException;

    /**
     * Settles a verified payment on the blockchain.
     *
     * @param paymentHeader the X-402 payment header to settle
     * @param req the payment requirements for settlement
     * @return settlement response with transaction details if successful
     * @throws IOException if HTTP request fails or returns non-200 status
     * @throws InterruptedException if the request is interrupted
     */
    SettlementResponse settle(String paymentHeader,
                              PaymentRequirements req)
            throws IOException, InterruptedException;

    /**
     * Retrieves the set of payment kinds supported by this facilitator.
     *
     * @return set of supported payment kinds (scheme/network combinations)
     * @throws IOException if HTTP request fails or returns non-200 status
     * @throws InterruptedException if the request is interrupted
     */
    Set<Kind> supported() throws IOException, InterruptedException;
}
