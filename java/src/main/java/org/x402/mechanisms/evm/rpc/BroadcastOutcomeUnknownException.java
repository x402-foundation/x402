package org.x402.mechanisms.evm.rpc;

import org.x402.mechanisms.evm.Hex;

import java.io.IOException;
import java.util.Objects;

/**
 * A signed transaction was handed to the node, but whether the node accepted it is unknown, e.g. because the
 * {@code eth_sendRawTransaction} reply timed out, a gateway answered with a 5xx status, the connection dropped
 * after sending or the thread was interrupted while waiting. The transaction may still be mined, so the exact
 * scheme reports {@code settlement_pending} with {@link #transactionHash()} and reconciles against it when the
 * payment is settled again.
 *
 * <p>{@link FacilitatorEvmSigner#sendTransaction(String, byte[])} implementations throw this type only when the
 * node may have accepted the transaction; a failure to connect, or a rejection such as a JSON-RPC error or an
 * HTTP 4xx status, is a plain {@link IOException}.
 */
public class BroadcastOutcomeUnknownException extends IOException {

    private static final long serialVersionUID = 1L;

    private final String transactionHash;

    /**
     * Creates an exception.
     *
     * @param transactionHash the {@code 0x}-prefixed 32-byte hash of the signed transaction, computed locally
     * @param message what happened, without the endpoint URL or the raw transaction
     * @param cause the transport failure or interruption, or {@code null}
     * @throws IllegalArgumentException if {@code transactionHash} is not 32 bytes of hex
     */
    public BroadcastOutcomeUnknownException(String transactionHash, String message, Throwable cause) {
        super(Objects.requireNonNull(message, "message"), cause);
        this.transactionHash = Hex.encode(Hex.decode(Objects.requireNonNull(transactionHash, "transactionHash"), 32));
    }

    /**
     * Returns the hash of the transaction that may have been broadcast.
     *
     * @return the lowercase {@code 0x}-prefixed 32-byte hash
     */
    public String transactionHash() {
        return transactionHash;
    }
}
