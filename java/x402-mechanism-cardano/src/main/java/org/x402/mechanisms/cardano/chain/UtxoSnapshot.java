package org.x402.mechanisms.cardano.chain;

import java.math.BigInteger;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One UTxO as the chain layer reports it.
 *
 * @param exists whether the UTxO is currently unspent
 * @param address the owner; implementations should report it even when spent, because a settle
 *     retry resolves the payer from it
 * @param coin lovelace held; required for an unspent input (value conservation)
 * @param assets native assets keyed by canonical unit, or {@code null}
 * @param paymentKeyHash lowercase payment key hash, {@code null} for script or legacy owners
 */
public record UtxoSnapshot(
    boolean exists,
    String address,
    BigInteger coin,
    Map<String, BigInteger> assets,
    String paymentKeyHash) {

  /** Copies the asset map. */
  public UtxoSnapshot {
    assets = assets == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(assets));
  }

  /**
   * A spent (or never existing) UTxO with its owner, when known.
   *
   * @param address the owner, or {@code null}
   * @return the snapshot
   */
  public static UtxoSnapshot spent(String address) {
    return new UtxoSnapshot(false, address, null, null, null);
  }
}
