package org.x402.e2e.client;

import org.x402.types.SettleResponse;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.JsonNode;

import java.net.HttpURLConnection;

/**
 * The single JSON line a client prints for the harness, with the field names of the Go client's {@code StepResult}.
 *
 * @param success whether the request was paid for and served
 * @param data the parsed response body
 * @param statusCode the HTTP status of the final response
 * @param paymentResponse the decoded {@code PAYMENT-RESPONSE} header, if any
 * @param error why the request failed
 */
public record ClientResult(
        boolean success,
        JsonNode data,
        @JsonProperty("status_code") Integer statusCode,
        @JsonProperty("payment_response") SettleResponse paymentResponse,
        String error) {

    /**
     * Creates the result of a request that never got a usable response.
     *
     * @param error what went wrong
     * @return the failed result
     */
    public static ClientResult failure(String error) {
        return new ClientResult(false, null, null, null, error);
    }

    /**
     * Returns the process exit code: 0 once the server answered with a 2xx or a 402, which the harness inspects
     * itself, and 1 for anything else so that a broken run never counts as a pass.
     *
     * @return the exit code
     */
    public int exitCode() {
        boolean answered = statusCode != null
                && (statusCode / 100 == 2 || statusCode == HttpURLConnection.HTTP_PAYMENT_REQUIRED);
        return answered ? 0 : 1;
    }
}
