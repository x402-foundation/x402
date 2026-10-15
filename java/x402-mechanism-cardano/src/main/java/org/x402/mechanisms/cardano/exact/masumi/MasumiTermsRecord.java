package org.x402.mechanisms.cardano.exact.masumi;

import org.x402.core.types.PaymentRequirements;

/**
 * One issued Masumi 402, keyed by the signed {@code termsDigest}.
 *
 * @param termsDigest the digest
 * @param requirements the requirements exactly as served
 * @param claimedTxHash the transaction bound by the first paid retry, or {@code null}
 */
public record MasumiTermsRecord(String termsDigest, PaymentRequirements requirements, String claimedTxHash) {

  /**
   * A copy bound to a transaction.
   *
   * @param txHash the canonical transaction id
   * @return the copy
   */
  public MasumiTermsRecord withClaimedTxHash(String txHash) {
    return new MasumiTermsRecord(termsDigest, requirements, txHash);
  }
}
