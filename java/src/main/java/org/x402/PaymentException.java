package org.x402;

/** Raised by a client when it cannot select requirements or create a payment. */
public class PaymentException extends X402Exception {

    private static final long serialVersionUID = 1L;

    /** No registered scheme can pay any of the offered requirements. */
    public static final String UNSUPPORTED_SCHEME = "unsupported_scheme";

    /**
     * The server's {@code PaymentRequired} is missing, cannot be decoded, declares a protocol version other than
     * {@code 2}, or lacks a required field.
     */
    public static final String INVALID_PAYMENT_REQUIRED = "invalid_payment_required";

    /** The server's {@code PAYMENT-RESPONSE} header cannot be decoded into a {@code SettleResponse}. */
    public static final String INVALID_PAYMENT_RESPONSE = "invalid_payment_response";

    /** Spend controls rejected every offered requirement because none uses an allowed asset. */
    public static final String SPEND_CONTROLS_ASSET_NOT_ALLOWED = "spend_controls_asset_not_allowed";

    /** Spend controls rejected every offered requirement because each exceeds its per-payment cap. */
    public static final String SPEND_CONTROLS_MAX_AMOUNT_EXCEEDED = "spend_controls_max_amount_exceeded";

    /**
     * Creates an exception.
     *
     * @param reason the machine-readable reason code
     * @param message the human-readable detail
     */
    public PaymentException(String reason, String message) {
        super(reason, message);
    }

    /**
     * Creates an exception with a cause.
     *
     * @param reason the machine-readable reason code
     * @param message the human-readable detail
     * @param cause the underlying cause
     */
    public PaymentException(String reason, String message, Throwable cause) {
        super(reason, message, cause);
    }
}
