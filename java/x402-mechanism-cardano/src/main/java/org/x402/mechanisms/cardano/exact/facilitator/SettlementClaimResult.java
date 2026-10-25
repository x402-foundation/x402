package org.x402.mechanisms.cardano.exact.facilitator;

/** Outcome of {@link SettlementClaimStore#claimSettlement}. */
public enum SettlementClaimResult {
  /** Nothing claimed this transaction (or a stale pre-fence claim was reclaimed); the caller submits it. */
  FRESH,
  /** Another call holds the claim before its broadcast fence; retry later. */
  IN_FLIGHT,
  /** Another call passed the broadcast fence; resume observing, never submit again. */
  SUBMITTING,
  /** Already broadcast: resume observing, never submit again. */
  SUBMITTED,
  /** This facilitator already reported success for the transaction. */
  SETTLED,
  /** The node definitively rejected these bytes; never resubmit. */
  REJECTED,
  /** The Masumi terms are bound to another transaction. */
  TERMS_CONFLICT,
  /** The transaction is claimed for other requirements or another resource. */
  BINDING_MISMATCH,
  /** The store is full and nothing in it can be evicted (see {@link InMemorySettlementClaimStore}). */
  CAPACITY_EXCEEDED;
}
