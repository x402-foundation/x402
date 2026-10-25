package org.x402.mechanisms.cardano.chain;

import java.util.Locale;

/**
 * Authenticated settlement evidence for one transaction.
 * {@code confirmations} is -1 for mempool acceptance, 0 for inclusion and {@code n} for {@code n}
 * newer blocks; it is meaningless when the status is {@link Status#UNKNOWN}.
 *
 * @param status the strongest evidence
 * @param confirmations the depth
 */
public record SettlementEvidence(Status status, int confirmations) {

  /** Evidence status. */
  public enum Status {
    /** The ledger has no record of the transaction. */
    UNKNOWN,
    /** Authenticated mempool acceptance. */
    MEMPOOL,
    /** Included in a canonical block. */
    CONFIRMED;

    /**
     * The wire string.
     *
     * @return {@code unknown}, {@code mempool} or {@code confirmed}
     */
    public String wire() {
      return name().toLowerCase(Locale.ROOT);
    }

    /**
     * Parses the wire string.
     *
     * @param wire the string
     * @return the status
     */
    public static Status fromWire(String wire) {
      return valueOf(wire.toUpperCase(Locale.ROOT));
    }
  }

  /**
   * No record of the transaction.
   *
   * @return the evidence
   */
  public static SettlementEvidence unknown() {
    return new SettlementEvidence(Status.UNKNOWN, -2);
  }
}
