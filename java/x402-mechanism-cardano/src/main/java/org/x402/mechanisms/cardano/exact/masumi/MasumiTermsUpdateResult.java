package org.x402.mechanisms.cardano.exact.masumi;

/**
 * The outcome of {@link MasumiTermsStorage#updateTerms}.
 *
 * @param terms the final stored record, or {@code null}
 * @param status what happened
 */
public record MasumiTermsUpdateResult(MasumiTermsRecord terms, Status status) {

  /** What the update did. */
  public enum Status {
    /** A new record was written. */
    UPDATED,
    /** The callback returned the current record (or nothing for an absent one). */
    UNCHANGED,
    /** The record was removed. */
    DELETED
  }
}
