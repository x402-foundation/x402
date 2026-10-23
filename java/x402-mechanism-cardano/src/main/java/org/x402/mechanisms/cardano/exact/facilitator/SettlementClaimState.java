package org.x402.mechanisms.cardano.exact.facilitator;

/**
 * The state of a stored settlement claim.
 */
public enum SettlementClaimState {
  /** Claimed; the broadcast fence is not passed, so nothing was sent. */
  IN_FLIGHT,
  /**
   * The broadcast fence is passed: the transaction may be on the wire, its outcome is not
   * recorded. Never reclaimed; resolved by evidence.
   */
  SUBMITTING,
  /** Broadcast; settlement may still be pending. Public verify resumes verification of it. */
  SUBMITTED,
  /** This facilitator reported success; a same-binding retry re-reads the evidence. */
  SETTLED,
  /** The node definitively rejected it; terminal. */
  REJECTED
}
