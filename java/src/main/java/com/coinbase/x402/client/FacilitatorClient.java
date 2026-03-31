package com.coinbase.x402.client;

import com.coinbase.x402.model.PaymentPayload;
import com.coinbase.x402.model.PaymentRequirements;

import java.io.IOException;
import java.util.Set;

/** Contract for calling an x402 facilitator (HTTP, gRPC, mock, etc.). */
public interface FacilitatorClient {
    /**
     * Verifies a payment payload against the given requirements.
     *
     * @param paymentPayload the payment payload to verify
     * @param req the payment requirements to validate against
     * @return verification response indicating if payment is valid
     * @throws IOException if HTTP request fails or returns non-200 status
     * @throws InterruptedException if the request is interrupted
     */
    VerificationResponse verify(PaymentPayload paymentPayload,
                                PaymentRequirements req)
            throws IOException, InterruptedException;

    /**
     * Settles a verified payment on the blockchain.
     *
     * @param paymentPayload the payment payload to settle
     * @param req the payment requirements for settlement
     * @return settlement response with transaction details if successful
     * @throws IOException if HTTP request fails or returns non-200 status
     * @throws InterruptedException if the request is interrupted
     */
    SettlementResponse settle(PaymentPayload paymentPayload,
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
