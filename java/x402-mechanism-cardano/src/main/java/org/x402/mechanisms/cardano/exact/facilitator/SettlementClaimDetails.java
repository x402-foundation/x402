package org.x402.mechanisms.cardano.exact.facilitator;

import java.util.Objects;

/**
 * A stored claim as settle's resume and public verify read it.
 *
 * @param state the state
 * @param bindingDigest the stored binding digest, or {@code null} when none was stored
 * @param payer the payer recorded at the broadcast fence ({@link
 *     SettlementClaimStore#beginSubmission}), or {@code null}
 */
public record SettlementClaimDetails(SettlementClaimState state, String bindingDigest, String payer) {

  /** Validates. */
  public SettlementClaimDetails {
    Objects.requireNonNull(state, "state");
  }
}
