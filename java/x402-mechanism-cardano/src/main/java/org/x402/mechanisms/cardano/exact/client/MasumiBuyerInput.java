package org.x402.mechanisms.cardano.exact.client;

/**
 * Buyer-side datum input; everything else comes from the
 * seller-signed terms.
 *
 * @param buyerReturnAddress datum {@code buyer_return_address}, or {@code null} for {@code None}
 */
public record MasumiBuyerInput(String buyerReturnAddress) {

  /** No buyer input. */
  public static final MasumiBuyerInput NONE = new MasumiBuyerInput(null);
}
