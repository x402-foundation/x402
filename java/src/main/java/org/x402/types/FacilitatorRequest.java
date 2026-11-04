package org.x402.types;

/**
 * Request body of a facilitator's {@code POST /verify} and {@code POST /settle} endpoints.
 *
 * @param x402Version the protocol version of {@code paymentPayload}
 * @param paymentPayload the payment to verify or settle
 * @param paymentRequirements the requirements the payment must satisfy
 */
public record FacilitatorRequest(
        int x402Version,
        PaymentPayload paymentPayload,
        PaymentRequirements paymentRequirements) {
}
