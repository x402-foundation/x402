package org.x402.types;

import java.util.List;
import java.util.Map;

/**
 * Body of the {@code PAYMENT-REQUIRED} header sent with an HTTP 402 response.
 *
 * @param x402Version the protocol version, always {@code 2}
 * @param error optional human-readable reason the payment is required or was rejected
 * @param resource the protected resource
 * @param accepts the accepted ways of paying, in server preference order
 * @param extensions optional extension declarations keyed by extension id
 */
public record PaymentRequired(
        int x402Version,
        String error,
        ResourceInfo resource,
        List<PaymentRequirements> accepts,
        Map<String, Object> extensions) {

    /** Creates a payment-required message, copying the collections. */
    public PaymentRequired {
        accepts = Immutables.list(accepts);
        extensions = Immutables.map(extensions);
    }
}
