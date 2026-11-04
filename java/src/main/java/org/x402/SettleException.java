package org.x402;

/** Raised when a payment fails to settle. */
public class SettleException extends X402Exception {

    private static final long serialVersionUID = 1L;

    private final String payer;
    private final String network;
    private final String transaction;
    private final String errorMessage;

    /**
     * Creates an exception.
     *
     * @param errorReason the machine-readable reason
     * @param payer the payer address, or {@code null} when unknown
     * @param network the CAIP-2 network
     * @param transaction the transaction hash, or an empty string when nothing was broadcast
     * @param errorMessage optional human-readable detail
     */
    public SettleException(
            String errorReason, String payer, String network, String transaction, String errorMessage) {
        super(errorReason, errorMessage == null ? errorReason : errorReason + ": " + errorMessage);
        this.payer = payer;
        this.network = network;
        this.transaction = transaction;
        this.errorMessage = errorMessage;
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
     * Returns the CAIP-2 network.
     *
     * @return the network
     */
    public String network() {
        return network;
    }

    /**
     * Returns the transaction hash.
     *
     * @return the hash, or an empty string when nothing was broadcast
     */
    public String transaction() {
        return transaction;
    }

    /**
     * Returns the human-readable detail.
     *
     * @return the detail, or {@code null}
     */
    public String errorMessage() {
        return errorMessage;
    }
}
