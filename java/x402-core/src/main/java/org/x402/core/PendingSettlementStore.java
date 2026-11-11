package org.x402.core;

import java.util.Optional;

/**
 * Remembers broadcast-but-unconfirmed transactions so a settle retry reconciles instead of
 * broadcasting again.
 * Implementations must be thread-safe; a multi-instance facilitator needs a shared one.
 *
 * <p>For scheme authors: a scheme that broadcasts can use it to make settle retries idempotent.
 * The Cardano scheme does not: it keeps a stronger record of its own ({@code
 * SettlementClaimStore}), which also guards against settling one transaction twice.
 */
public interface PendingSettlementStore {

  /**
   * Returns the stored transaction for a key, unless expired.
   *
   * @param key a deterministic id derived from the payment payload
   * @return the transaction hash
   */
  Optional<String> get(String key);

  /**
   * Records a broadcast transaction for a key, overwriting any previous value.
   *
   * @param key the key
   * @param txHash the transaction hash
   */
  void set(String key, String txHash);

  /**
   * Removes the entry once the transaction is confirmed or terminally failed.
   *
   * @param key the key
   */
  void delete(String key);
}
