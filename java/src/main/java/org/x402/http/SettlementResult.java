package org.x402.http;

import org.x402.types.SettleResponse;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * Outcome of {@link HttpResourceServer#processSettlement(ProcessResult.PaymentVerified)}.
 */
public sealed interface SettlementResult permits SettlementResult.Settled, SettlementResult.Failed {

    /**
     * Returns the settle response sent to the client in the {@code PAYMENT-RESPONSE} header.
     *
     * @return the settle response
     */
    SettleResponse settleResponse();

    /**
     * The payment settled. Add {@code headers} to the buffered response, merge {@code private} into its
     * {@code Cache-Control} with {@link HttpResourceServer#withPrivateCacheControl(String)}, then release it.
     *
     * @param settleResponse the facilitator's successful settle response
     * @param headers the headers to add, i.e. {@code PAYMENT-RESPONSE}
     */
    record Settled(SettleResponse settleResponse, Map<String, String> headers) implements SettlementResult {

        /**
         * Creates a settled result, copying {@code headers}.
         */
        public Settled {
            Objects.requireNonNull(settleResponse, "settleResponse");
            headers = Collections.unmodifiableMap(new LinkedHashMap<>(Objects.requireNonNull(headers, "headers")));
        }
    }

    /**
     * Settlement failed. Discard the buffered response and write {@code response} instead: a 402 with
     * {@code {"error":"settlement_failed"}}, a {@code PAYMENT-RESPONSE} header carrying {@code settleResponse}
     * and {@code Cache-Control: no-store}.
     *
     * @param settleResponse the failure receipt, with {@code success=false}
     * @param response the response to write instead of the protected one
     */
    record Failed(SettleResponse settleResponse, HttpResponseInstructions response) implements SettlementResult {

        /**
         * Creates a failed result.
         */
        public Failed {
            Objects.requireNonNull(settleResponse, "settleResponse");
            Objects.requireNonNull(response, "response");
        }
    }
}
