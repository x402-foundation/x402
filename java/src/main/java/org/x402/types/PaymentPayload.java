package org.x402.types;

import java.util.Map;

/**
 * Body of the {@code PAYMENT-SIGNATURE} request header.
 *
 * @param x402Version the protocol version, always {@code 2}
 * @param payload the scheme-specific payload, e.g. an EIP-3009 signature and authorization
 * @param accepted the {@link PaymentRequirements} entry the client chose, copied verbatim
 * @param resource optional resource the payment is for
 * @param extensions optional extension data echoed from the server
 */
public record PaymentPayload(
        int x402Version,
        Map<String, Object> payload,
        PaymentRequirements accepted,
        ResourceInfo resource,
        Map<String, Object> extensions) {

    /** Creates a payment payload, copying the maps. */
    public PaymentPayload {
        payload = Immutables.map(payload);
        extensions = Immutables.map(extensions);
    }
}
