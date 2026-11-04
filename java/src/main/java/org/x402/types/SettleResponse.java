package org.x402.types;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * Result of settling a payment, also sent to the client in the {@code PAYMENT-RESPONSE} header.
 *
 * @param success whether settlement succeeded
 * @param errorReason machine-readable reason when settlement failed
 * @param errorMessage optional human-readable detail
 * @param payer the payer address, when known
 * @param transaction the transaction hash, or an empty string when nothing was broadcast
 * @param network the CAIP-2 network the payment settled on
 * @param amount optional settled amount in atomic units
 * @param extensions optional extension data
 * @param extra optional scheme-specific data
 */
public record SettleResponse(
        boolean success,
        String errorReason,
        String errorMessage,
        String payer,
        @JsonInclude(JsonInclude.Include.ALWAYS) String transaction,
        @JsonInclude(JsonInclude.Include.ALWAYS) String network,
        String amount,
        Map<String, Object> extensions,
        Map<String, Object> extra) {

    /** Creates a settle response, copying the maps. */
    public SettleResponse {
        extensions = Immutables.map(extensions);
        extra = Immutables.map(extra);
    }

    /**
     * Creates a successful settle response.
     *
     * @param payer the payer address
     * @param transaction the transaction hash
     * @param network the CAIP-2 network
     * @return the response
     */
    public static SettleResponse success(String payer, String transaction, String network) {
        return new SettleResponse(true, null, null, payer, transaction, network, null, null, null);
    }

    /**
     * Creates a failed settle response.
     *
     * @param errorReason the machine-readable reason
     * @param errorMessage optional human-readable detail
     * @param payer the payer address, or {@code null} when unknown
     * @param transaction the transaction hash, or an empty string when nothing was broadcast
     * @param network the CAIP-2 network
     * @return the response
     */
    public static SettleResponse failure(
            String errorReason, String errorMessage, String payer, String transaction, String network) {
        return new SettleResponse(false, errorReason, errorMessage, payer, transaction, network, null, null, null);
    }
}
