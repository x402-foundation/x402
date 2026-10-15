package org.x402.mechanisms.cardano.exact.facilitator;

import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Bounded process-local {@link SettlementClaimStore}, the facilitator default. Single instance
 * only.
 *
 * <p>When full, a new claim evicts, oldest first: a record that is rejected or past its retention
 * ({@link SettlementClaim#retainUntilMs()}, the TTL plus a grace); otherwise a record whose
 * submission is unconfirmed and that never settled. In-flight claims, and submitting, submitted
 * or settled records still within their retention, are never evicted; if nothing can go, the
 * claim reports {@link SettlementClaimResult#CAPACITY_EXCEEDED}. A submitted transaction is kept
 * while it could still land, so it cannot be settled twice from the mempool.
 *
 * <p>With a stale-claim timeout, an in-flight claim older than it is handed to the next claim
 * with the same binding; its former owner then fails the broadcast fence. Without one (the
 * default), in-flight claims are never reclaimed.
 */
public final class InMemorySettlementClaimStore implements SettlementClaimStore {

  /** Default combined capacity of transaction and terms entries. */
  public static final int DEFAULT_MAX_ENTRIES = 4096;

  private static final class Record {
    final String txHash;
    final String termsDigest;
    final String bindingDigest;
    String ownerToken;
    Long retainUntilMs;
    long claimedAtMs;
    SettlementClaimState phase = SettlementClaimState.IN_FLIGHT;
    boolean unconfirmed;
    String payer;

    Record(SettlementClaim claim, long now) {
      this.txHash = claim.txHash();
      this.ownerToken = claim.ownerToken();
      this.termsDigest = claim.termsDigest();
      this.retainUntilMs = claim.retainUntilMs();
      this.bindingDigest = claim.binding() == null ? null : claim.binding().digest();
      this.claimedAtMs = now;
    }

    /** Rejected, or past the time its transaction could still land (never without a TTL). */
    boolean expired(long now) {
      if (phase == SettlementClaimState.IN_FLIGHT) {
        return false;
      }
      return phase == SettlementClaimState.REJECTED || (retainUntilMs != null && now >= retainUntilMs);
    }

    /** An unknown broadcast outcome that never produced a success. */
    boolean droppable() {
      return unconfirmed && phase == SettlementClaimState.SUBMITTED;
    }
  }

  private final Map<String, Record> submissions = new LinkedHashMap<>();
  private final Map<String, String> terms = new HashMap<>();
  private final int maxEntries;
  private final Clock clock;
  private final Duration staleClaimAfter;

  /** Creates a store with {@link #DEFAULT_MAX_ENTRIES}. */
  public InMemorySettlementClaimStore() {
    this(DEFAULT_MAX_ENTRIES);
  }

  /**
   * Creates a bounded store.
   *
   * @param maxEntries combined transaction and terms entry limit
   */
  public InMemorySettlementClaimStore(int maxEntries) {
    this(maxEntries, Clock.systemUTC());
  }

  /**
   * A store with a capacity and the clock its retention rule reads.
   *
   * @param maxEntries the capacity
   * @param clock the clock
   */
  public InMemorySettlementClaimStore(int maxEntries, Clock clock) {
    this(maxEntries, clock, null);
  }

  /**
   * A store that reclaims stale in-flight claims. Choose a timeout longer than one settle's
   * verification and broadcast (lookup timeout plus evaluation plus confirmation timeout).
   *
   * @param maxEntries the capacity
   * @param clock the clock
   * @param staleClaimAfter how old an in-flight claim must be to be reclaimed, or {@code null}
   *     to never reclaim
   */
  public InMemorySettlementClaimStore(int maxEntries, Clock clock, Duration staleClaimAfter) {
    if (maxEntries <= 0) {
      throw new IllegalArgumentException("maxEntries must be a positive integer");
    }
    if (staleClaimAfter != null && (staleClaimAfter.isNegative() || staleClaimAfter.isZero())) {
      throw new IllegalArgumentException("staleClaimAfter must be positive");
    }
    this.maxEntries = maxEntries;
    this.clock = Objects.requireNonNull(clock, "clock");
    this.staleClaimAfter = staleClaimAfter;
  }

  @Override
  public synchronized SettlementClaimResult claimSettlement(SettlementClaim claim) {
    long now = clock.millis();
    Record existing = submissions.get(claim.txHash());
    if (existing != null) {
      if (existing.bindingDigest != null && claim.binding() != null
          && !claim.binding().matches(existing.bindingDigest)) {
        return SettlementClaimResult.BINDING_MISMATCH;
      }
      if (!Objects.equals(existing.termsDigest, claim.termsDigest())) {
        return SettlementClaimResult.TERMS_CONFLICT;
      }
      if (existing.phase == SettlementClaimState.IN_FLIGHT && staleClaimAfter != null
          && now - existing.claimedAtMs >= staleClaimAfter.toMillis()) {
        // Never past the fence, so nothing was sent: hand the claim to this owner.
        existing.ownerToken = claim.ownerToken();
        existing.claimedAtMs = now;
        existing.retainUntilMs = claim.retainUntilMs();
        existing.payer = null;
        return SettlementClaimResult.FRESH;
      }
      return switch (existing.phase) {
        case IN_FLIGHT -> SettlementClaimResult.IN_FLIGHT;
        case SUBMITTING -> SettlementClaimResult.SUBMITTING;
        case SUBMITTED -> SettlementClaimResult.SUBMITTED;
        case SETTLED -> SettlementClaimResult.SETTLED;
        case REJECTED -> SettlementClaimResult.REJECTED;
      };
    }
    String existingTerms = claim.termsDigest() == null ? null : terms.get(claim.termsDigest());
    if (existingTerms != null && !existingTerms.equals(claim.txHash())) {
      return SettlementClaimResult.TERMS_CONFLICT;
    }
    int required = 1 + (claim.termsDigest() != null && existingTerms == null ? 1 : 0);
    while (submissions.size() + terms.size() + required > maxEntries) {
      if (!evictOne()) {
        return SettlementClaimResult.CAPACITY_EXCEEDED;
      }
    }
    if (claim.termsDigest() != null && existingTerms == null) {
      terms.put(claim.termsDigest(), claim.txHash());
    }
    submissions.put(claim.txHash(), new Record(claim, now));
    return SettlementClaimResult.FRESH;
  }

  @Override
  public synchronized boolean beginSubmission(String txHash, String ownerToken, String payer) {
    Record record = submissions.get(txHash);
    if (record == null || !record.ownerToken.equals(ownerToken) || record.phase != SettlementClaimState.IN_FLIGHT) {
      return false;
    }
    record.phase = SettlementClaimState.SUBMITTING;
    record.payer = payer == null || payer.isBlank() ? null : payer;
    return true;
  }

  @Override
  public synchronized void markSubmitted(String txHash, String ownerToken) {
    Record record = owned(txHash, ownerToken);
    if (record != null) {
      record.phase = SettlementClaimState.SUBMITTED;
      record.unconfirmed = false;
    }
  }

  @Override
  public synchronized void markSubmissionUnconfirmed(String txHash, String ownerToken) {
    Record record = owned(txHash, ownerToken);
    if (record != null) {
      record.phase = SettlementClaimState.SUBMITTED;
      record.unconfirmed = true;
    }
  }

  @Override
  public synchronized void markSubmissionObserved(String txHash) {
    Record record = submissions.get(txHash);
    if (record != null && record.phase == SettlementClaimState.SUBMITTED) {
      record.unconfirmed = false;
    }
  }

  @Override
  public synchronized void markRejected(String txHash, String ownerToken) {
    Record record = owned(txHash, ownerToken);
    if (record != null) {
      record.phase = SettlementClaimState.REJECTED;
    }
  }

  /** The owner's record while its outcome is unresolved (in flight or past the fence). */
  private Record owned(String txHash, String ownerToken) {
    Record record = submissions.get(txHash);
    return record != null && record.ownerToken.equals(ownerToken)
        && (record.phase == SettlementClaimState.IN_FLIGHT || record.phase == SettlementClaimState.SUBMITTING)
        ? record : null;
  }

  @Override
  public synchronized boolean markSettled(String txHash, String ownerToken) {
    Record record = submissions.get(txHash);
    if (record == null || record.phase == SettlementClaimState.REJECTED
        || record.phase == SettlementClaimState.SETTLED) {
      return false;
    }
    if (record.phase == SettlementClaimState.IN_FLIGHT && !record.ownerToken.equals(ownerToken)) {
      return false;
    }
    record.phase = SettlementClaimState.SETTLED;
    record.unconfirmed = false;
    return true;
  }

  @Override
  public synchronized Optional<SettlementClaimState> claimState(String txHash) {
    Record record = submissions.get(txHash);
    return record == null ? Optional.empty() : Optional.of(record.phase);
  }

  @Override
  public synchronized Optional<SettlementClaimDetails> claimDetails(String txHash) {
    Record record = submissions.get(txHash);
    return record == null ? Optional.empty()
        : Optional.of(new SettlementClaimDetails(record.phase, record.bindingDigest, record.payer));
  }

  @Override
  public synchronized void releaseClaim(String txHash, String ownerToken) {
    Record record = submissions.get(txHash);
    if (record == null || !record.ownerToken.equals(ownerToken) || record.phase != SettlementClaimState.IN_FLIGHT) {
      return;
    }
    submissions.remove(txHash);
    dropTerms(record);
  }

  @Override
  public synchronized void releaseUnsent(String txHash, String ownerToken) {
    Record record = submissions.get(txHash);
    if (record == null || !record.ownerToken.equals(ownerToken)
        || (record.phase != SettlementClaimState.IN_FLIGHT && record.phase != SettlementClaimState.SUBMITTING)) {
      return;
    }
    submissions.remove(txHash);
    dropTerms(record);
  }

  private void dropTerms(Record record) {
    if (record.termsDigest != null && record.txHash.equals(terms.get(record.termsDigest))) {
      terms.remove(record.termsDigest);
    }
  }

  /** Evicts the oldest expired record, else the oldest droppable one. */
  private boolean evictOne() {
    long now = clock.millis();
    return evictFirst(record -> record.expired(now)) || evictFirst(Record::droppable);
  }

  private boolean evictFirst(java.util.function.Predicate<Record> candidate) {
    Iterator<Record> it = submissions.values().iterator();
    while (it.hasNext()) {
      Record record = it.next();
      if (candidate.test(record)) {
        it.remove();
        dropTerms(record);
        return true;
      }
    }
    return false;
  }
}
