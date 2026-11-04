package org.x402.types;

import java.util.Map;

/**
 * One way of paying for a resource, as listed in {@link PaymentRequired#accepts()}.
 *
 * @param scheme the payment scheme, e.g. {@code "exact"}
 * @param network the CAIP-2 network identifier, e.g. {@code "eip155:84532"}
 * @param asset the token contract address
 * @param amount the amount in the asset's atomic units, as a decimal string
 * @param payTo the recipient address
 * @param maxTimeoutSeconds the maximum time the server waits for the payment to settle
 * @param extra scheme-specific data, e.g. the EIP-712 domain {@code name} and {@code version}
 */
public record PaymentRequirements(
        String scheme,
        String network,
        String asset,
        String amount,
        String payTo,
        int maxTimeoutSeconds,
        Map<String, Object> extra) {

    /** Creates payment requirements, copying {@code extra}. */
    public PaymentRequirements {
        extra = Immutables.map(extra);
    }

    /**
     * Returns a copy with {@code extra} replaced.
     *
     * @param newExtra the new scheme-specific data
     * @return the updated requirements
     */
    public PaymentRequirements withExtra(Map<String, Object> newExtra) {
        return new PaymentRequirements(scheme, network, asset, amount, payTo, maxTimeoutSeconds, newExtra);
    }
}
