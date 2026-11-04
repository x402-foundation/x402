package org.x402;

import java.io.IOException;
import java.util.Optional;

/**
 * Remembers settlement transactions that were broadcast but not confirmed, so that settling the same payment again
 * reconciles against the transaction already sent instead of broadcasting a second one.
 *
 * <p>A scheme facilitator that reports {@code settlement_pending} first stores the transaction hash under a key
 * derived from the payment payload, e.g. the EIP-3009 signature. When the same payload is settled again, typically
 * by the resource server's single automatic retry, it finds the hash, removes the entry and waits for that
 * transaction. The entry is also removed once the transaction has a receipt.
 *
 * <p>{@link InMemoryPendingSettlementStore} only helps when the retry reaches the same process. A facilitator
 * running several replicas without session affinity needs a shared implementation, e.g. one backed by Redis.
 * Implementations must be thread-safe.
 */
public interface PendingSettlementStore {

    /**
     * Returns the transaction hash stored for a payment.
     *
     * @param key the payment's key
     * @return the {@code 0x}-prefixed transaction hash, or empty when there is no entry or it expired
     * @throws IOException if the store cannot be reached
     */
    Optional<String> get(String key) throws IOException;

    /**
     * Records that a payment broadcast a transaction that is not confirmed yet, replacing any previous entry.
     *
     * @param key the payment's key
     * @param transactionHash the {@code 0x}-prefixed hash of the broadcast transaction
     * @throws IOException if the store cannot be reached; the caller must then not report the settlement as
     *     pending, since a retry would not find the transaction
     */
    void put(String key, String transactionHash) throws IOException;

    /**
     * Removes a payment's entry, if any.
     *
     * @param key the payment's key
     * @throws IOException if the store cannot be reached
     */
    void remove(String key) throws IOException;
}
