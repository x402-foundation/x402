package org.x402.http;

import org.x402.types.PaymentPayload;
import org.x402.types.PaymentRequirements;

import java.util.Objects;

/**
 * Outcome of {@link HttpResourceServer#processRequest(HttpRequestAdapter)}, telling the framework adapter what
 * to do before the protected handler runs.
 *
 * <pre>{@code
 * ProcessResult result = server.processRequest(adapter);
 * if (result instanceof ProcessResult.PaymentError error) {
 *     write(error.response()); // the handler must not run
 * } else if (result instanceof ProcessResult.PaymentVerified verified) {
 *     // run the handler into a buffer, then call server.processSettlement(verified)
 * } else {
 *     // NoPaymentRequired: run the handler normally
 * }
 * }</pre>
 */
public sealed interface ProcessResult
        permits ProcessResult.NoPaymentRequired, ProcessResult.PaymentError, ProcessResult.PaymentVerified {

    /** The request does not match a paid route; pass it through untouched. */
    record NoPaymentRequired() implements ProcessResult {
    }

    /**
     * The request must be answered with {@code response} and the protected handler must not run.
     *
     * @param response the response to write
     */
    record PaymentError(HttpResponseInstructions response) implements ProcessResult {

        /**
         * Creates a payment error.
         */
        public PaymentError {
            Objects.requireNonNull(response, "response");
        }
    }

    /**
     * The payment was verified. Run the protected handler with its response buffered, then settle with
     * {@link HttpResourceServer#processSettlement(PaymentVerified)} unless the handler failed.
     *
     * @param payload the client's payment
     * @param requirements the requirements the payment matched
     */
    record PaymentVerified(PaymentPayload payload, PaymentRequirements requirements) implements ProcessResult {

        /**
         * Creates a verified result.
         */
        public PaymentVerified {
            Objects.requireNonNull(payload, "payload");
            Objects.requireNonNull(requirements, "requirements");
        }
    }
}
