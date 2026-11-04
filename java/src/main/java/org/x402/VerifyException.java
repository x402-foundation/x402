package org.x402;

/** Raised when a payment fails verification. */
public class VerifyException extends X402Exception {

    private static final long serialVersionUID = 1L;

    private final String payer;
    private final String invalidMessage;

    /**
     * Creates an exception.
     *
     * @param invalidReason the machine-readable reason, e.g. {@code "invalid_exact_evm_signature"}
     * @param payer the payer address, or {@code null} when unknown
     * @param invalidMessage optional human-readable detail
     */
    public VerifyException(String invalidReason, String payer, String invalidMessage) {
        super(invalidReason, invalidMessage == null ? invalidReason : invalidReason + ": " + invalidMessage);
        this.payer = payer;
        this.invalidMessage = invalidMessage;
    }

    /**
     * Returns the payer address.
     *
     * @return the payer, or {@code null} when unknown
     */
    public String payer() {
        return payer;
    }

    /**
     * Returns the human-readable detail.
     *
     * @return the detail, or {@code null}
     */
    public String invalidMessage() {
        return invalidMessage;
    }
}
