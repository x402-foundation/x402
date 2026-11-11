package org.x402.mechanisms.cardano.exact.facilitator;

import java.util.Optional;

/**
 * Duplicate-settlement guard shared by every facilitator worker. Keyed by the canonical
 * transaction id, it makes sure one transaction is broadcast at most once while its claim is
 * retained, and lets a retry resume observing it. A claim is bound to its requirements and
 * resource ({@link SettlementBinding}); a claim with another binding is a duplicate. A record
 * moves to settled once; a later settle with the same binding answers success again only after
 * re-reading the ledger evidence. (An unconfirmed record dropped for room may be broadcast again;
 * the ledger accepts it at most once.)
 *
 * <p>Contract for implementations (JDBC, Redis, ...), every operation atomic across all instances
 * sharing the store:
 *
 * <ul>
 *   <li>a claim taken before broadcast (in flight) is never dropped; a store may reclaim it for a
 *       new owner once it is stale, but then must implement {@link #beginSubmission}, so the
 *       former owner cannot broadcast;
 *   <li>a claim past the broadcast fence ({@link SettlementClaimState#SUBMITTING}) is never
 *       reclaimed, and is kept like a submitted record;
 *   <li>a submitted or settled record is kept at least until its {@link
 *       SettlementClaim#retainUntilMs()} (the transaction's TTL plus a grace), and forever when
 *       that is {@code null}. Dropping it earlier would let a transaction still in a mempool be
 *       settled, and paid for, a second time;
 *   <li>a record marked by {@link #markSubmissionUnconfirmed} that never settled may be dropped
 *       when the store needs room: its broadcast outcome is unknown and no success was reported
 *       for it, so dropping it can never produce a second success;
 *   <li>a rejected record may be dropped at any time.
 * </ul>
 *
 * <p>With {@link #beginSubmission}, a claim whose broadcast outcome was never recorded (the store
 * was unreachable after the broadcast, or the process died) stays {@link
 * SettlementClaimState#SUBMITTING}, and retries resume it by evidence. Without it (the default),
 * such a claim stays in flight and retries answer {@code settlement_pending}.
 *
 * <p>Public verify refuses any transaction the store knows ({@link #claimState}), except a
 * broadcast one, which a pending retry may resume. {@link #claimSettlement} and {@link
 * #claimState} are abstract on purpose: a store that cannot answer them would let a settled
 * payment be replayed.
 *
 * <p>A delegating store must forward every method, the defaults included: a wrapper that keeps a
 * default would lose the fence, the binding or the payer of the store it wraps.
 */
public interface SettlementClaimStore {

  /**
   * Atomically claims a transaction and its optional Masumi terms digest. Leaves no partial
   * terms binding when the claim fails. For an existing record, in this order: a stored binding
   * the claim's binding does not match is {@link SettlementClaimResult#BINDING_MISMATCH} (no
   * comparison when either is {@code null}); other terms are {@link
   * SettlementClaimResult#TERMS_CONFLICT}; a stale in-flight claim may be reclaimed for this
   * owner ({@link SettlementClaimResult#FRESH}); otherwise the stored state. A new record stores
   * {@code claim.binding().digest()}.
   *
   * @param claim the claim
   * @return the outcome
   */
  SettlementClaimResult claimSettlement(SettlementClaim claim);

  /**
   * Marks an owned claim as broadcast (owner only, from in flight or submitting).
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   */
  void markSubmitted(String txHash, String ownerToken);

  /**
   * Records a definitive pre-ledger rejection as a permanent tombstone (owner only).
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   */
  void markRejected(String txHash, String ownerToken);

  /**
   * Atomically records that this facilitator reported success for a broadcast transaction. Only
   * one caller wins: the owner of an in-flight claim, or any caller once the claim is submitting
   * or submitted (the pending retry resumes under a new owner token). Rejected or already settled
   * records do not change.
   *
   * @param txHash the transaction id
   * @param ownerToken the caller's owner token
   * @return {@code true} when this call moved the record to settled
   */
  boolean markSettled(String txHash, String ownerToken);

  /**
   * The state of the stored record for a transaction, read by public verify. Must reflect
   * every write already acknowledged to any instance sharing the store.
   *
   * @param txHash the transaction id
   * @return the state, or empty when the store holds no record
   */
  Optional<SettlementClaimState> claimState(String txHash);

  /**
   * Gives up an owned claim that is still in flight (verification failed before broadcast),
   * together with its terms binding. A no-op for another owner or a broadcast claim.
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   */
  void releaseClaim(String txHash, String ownerToken);

  /**
   * Marks an owned claim as broadcast with an unknown outcome: the submission failed and the
   * ledger does not show the transaction. Readers see it as submitted (a retry resumes and never
   * rebroadcasts), but a store may drop it when it needs room, because no success was reported
   * for it. The default keeps it like {@link #markSubmitted}.
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   */
  default void markSubmissionUnconfirmed(String txHash, String ownerToken) {
    markSubmitted(txHash, ownerToken);
  }

  /**
   * Records that the ledger now shows a transaction whose submission was unconfirmed, so its
   * record is kept like any other submitted one. Callable by any instance; the default does
   * nothing.
   *
   * @param txHash the transaction id
   */
  default void markSubmissionObserved(String txHash) {}

  /**
   * The broadcast fence: atomically moves an in-flight claim owned by {@code ownerToken} to
   * {@link SettlementClaimState#SUBMITTING} and records the payer. Called after verification,
   * before the transaction leaves the process. After {@code true} the claim is never reclaimed.
   * The default answers {@code true} and records nothing: a store that never reclaims cannot
   * lose an in-flight claim.
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   * @param payer the payer of the valid verification verdict (the nonce owner), or {@code null};
   *     only ever compared with the on-chain nonce owner
   * @return {@code true} when the caller holds the fence; {@code false} when the claim is no
   *     longer this owner's in-flight claim: the caller must not broadcast
   */
  default boolean beginSubmission(String txHash, String ownerToken, String payer) {
    return true;
  }

  /**
   * The owner's transaction provably never reached a node. Removes the claim with its terms
   * binding when it is in flight or submitting and owned by {@code ownerToken}; a no-op
   * otherwise. The default is {@link #releaseClaim} (without a fence the claim is in flight).
   *
   * @param txHash the transaction id
   * @param ownerToken the owner token
   */
  default void releaseUnsent(String txHash, String ownerToken) {
    releaseClaim(txHash, ownerToken);
  }

  /**
   * The stored record as settle's resume and public verify read it. Must reflect every
   * acknowledged write. Never returns a payer that did not come through {@link
   * #beginSubmission}. The default maps {@link #claimState} with no binding and no payer.
   *
   * @param txHash the transaction id
   * @return the details, or empty when the store holds no record
   */
  default Optional<SettlementClaimDetails> claimDetails(String txHash) {
    Optional<SettlementClaimState> state = claimState(txHash);
    return state == null ? null : state.map(s -> new SettlementClaimDetails(s, null, null));
  }
}
