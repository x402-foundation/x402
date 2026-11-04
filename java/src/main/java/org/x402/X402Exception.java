package org.x402;

/** Base class for x402 protocol failures. Each failure carries a machine-readable reason code. */
public class X402Exception extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String reason;

    /**
     * Creates an exception.
     *
     * @param reason the machine-readable reason code
     * @param message the human-readable detail
     */
    public X402Exception(String reason, String message) {
        super(message);
        this.reason = reason;
    }

    /**
     * Creates an exception with a cause.
     *
     * @param reason the machine-readable reason code
     * @param message the human-readable detail
     * @param cause the underlying cause
     */
    public X402Exception(String reason, String message, Throwable cause) {
        super(message, cause);
        this.reason = reason;
    }

    /**
     * Returns the machine-readable reason code, e.g. {@code "unsupported_scheme"}.
     *
     * @return the reason code
     */
    public String reason() {
        return reason;
    }
}
