package org.x402.mechanisms.cardano.exact.masumi;

/** Signs {@code termsDigest} on the seller's behalf. */
@FunctionalInterface
public interface MasumiTermsSigner {

  /**
   * CIP-30 {@code signData(sellerAddress, termsDigestHex)}.
   *
   * @param sellerAddress the seller's bech32 address
   * @param termsDigestHex the digest as lowercase hex
   * @return the authorization
   */
  MasumiSellerAuthorization signTerms(String sellerAddress, String termsDigestHex);
}
