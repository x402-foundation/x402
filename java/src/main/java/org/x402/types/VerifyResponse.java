package org.x402.types;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.Map;

/**
 * Result of verifying a payment with a facilitator.
 *
 * @param isValid whether the payment is valid
 * @param invalidReason machine-readable reason when invalid, e.g. {@code "invalid_exact_evm_signature"}
 * @param invalidMessage optional human-readable detail
 * @param payer the payer address, when known
 * @param extensions optional extension data
 * @param extra optional scheme-specific data
 */
public record VerifyResponse(
        @JsonProperty("isValid") boolean isValid,
        String invalidReason,
        String invalidMessage,
        String payer,
        Map<String, Object> extensions,
        Map<String, Object> extra) {

    /** Creates a verify response, copying the maps. */
    public VerifyResponse {
        extensions = Immutables.map(extensions);
        extra = Immutables.map(extra);
    }

    /**
     * Creates a successful verify response.
     *
     * @param payer the payer address
     * @return the response
     */
    public static VerifyResponse valid(String payer) {
        return new VerifyResponse(true, null, null, payer, null, null);
    }

    /**
     * Creates a failed verify response.
     *
     * @param invalidReason the machine-readable reason
     * @param invalidMessage optional human-readable detail
     * @param payer the payer address, or {@code null} when unknown
     * @return the response
     */
    public static VerifyResponse invalid(String invalidReason, String invalidMessage, String payer) {
        return new VerifyResponse(false, invalidReason, invalidMessage, payer, null, null);
    }
}
