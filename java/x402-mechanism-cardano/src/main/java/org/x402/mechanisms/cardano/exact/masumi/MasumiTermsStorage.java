package org.x402.mechanisms.cardano.exact.masumi;

import java.util.function.UnaryOperator;

/**
 * Storage of issued Masumi quotes keyed by {@code termsDigest}.
 * The resource server binds each digest to the first transaction that claims it.
 */
public interface MasumiTermsStorage {

  /**
   * The stored record of a digest.
   *
   * @param termsDigest the digest
   * @return the record, or {@code null}
   */
  MasumiTermsRecord get(String termsDigest);

  /**
   * Atomically inspects and mutates one record. No concurrent mutation may interleave between
   * reading {@code current} and writing the callback's result, for every application instance
   * that shares the backend (the in-memory default only within one JVM). Return {@code null} to
   * delete, or {@code current} itself to leave it unchanged.
   *
   * @param termsDigest the digest
   * @param update the callback
   * @return the final record and whether it was updated, unchanged or deleted
   */
  MasumiTermsUpdateResult updateTerms(String termsDigest, UnaryOperator<MasumiTermsRecord> update);
}
