package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.ResourceInfo;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.FakeChain.SubmitMode;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;

/**
 * The settlement claim lifecycle through the scheme: replay only on freshly read evidence (D1),
 * the broadcast fence (I3), explicit claim results (I4), the never-sent release (I5), the binding
 * on every claim (I8), pending answers for unknown outcomes (D2/D3) and the payer recorded at the
 * fence (N3).
 */
class SettlementClaimLifecycleTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);
  private static final String OTHER_PAYER =
      "addr_test1qq9lafv5q6tzm0hj7dhwn9sw3pt8at7utl72lmk4xqcjts2k34ky8776vzes76ae0hhdful5l3ejn2teha8pgsz4jyxquttlcd";

  private final JsonNode fixture = Vectors.fixture("01-default-happy");
  private final PaymentPayload payload = Vectors.payload(fixture.get("payload"));
  private final PaymentRequirements requirements = Vectors.requirements(fixture.get("requirements"));
  private final String tx = (String) payload.payload().get("transaction");
  private final String nonce = (String) payload.payload().get("nonce");
  private final String hash = CardanoTransactionDecoder.decode(tx).txHash();
  private final long ttl = CardanoTransactionDecoder.decode(tx).ttlSlot().longValueExact();
  private final SettlementBinding binding = SettlementBinding.of(requirements, payload.resource());

  /** A FakeChain whose evidence, nonce lookup and classifiers a test can override. */
  private static class Chain implements CardanoChainBackend {
    final FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    boolean evidenceFails;
    SettlementEvidence forcedEvidence;
    boolean nonceLookupFails;
    String nonceOwner;
    String nonceRef;
    boolean definitive;
    boolean neverSentCapable = true;

    @Override
    public UtxoSnapshot getUtxo(String ref, String network) {
      if (ref.equals(nonceRef)) {
        if (nonceLookupFails) {
          throw new IllegalStateException("provider unavailable");
        }
        if (nonceOwner != null) {
          return UtxoSnapshot.spent(nonceOwner);
        }
      }
      return chain.getUtxo(ref, network);
    }

    @Override
    public long getCurrentSlot(String network) {
      return chain.getCurrentSlot(network);
    }

    @Override
    public ProtocolParams getProtocolParameters(String network) {
      return chain.getProtocolParameters(network);
    }

    @Override
    public SubmissionResult submitTransaction(String signed, String network) {
      return chain.submitTransaction(signed, network);
    }

    @Override
    public boolean isSubmissionNeverSent(Throwable error) {
      return neverSentCapable && chain.isSubmissionNeverSent(error);
    }

    @Override
    public boolean isDefinitiveSubmissionRejection(Throwable error) {
      return definitive || chain.isDefinitiveSubmissionRejection(error);
    }

    @Override
    public boolean supportsTransactionEvidence() {
      return true;
    }

    @Override
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      if (evidenceFails) {
        throw new IllegalStateException("provider unavailable");
      }
      return forcedEvidence != null ? forcedEvidence : chain.getTransactionEvidence(txHash, network);
    }
  }

  /** Delegates every method, the new ones included; each can be made to misbehave. */
  private static class Fenced implements SettlementClaimStore {
    final InMemorySettlementClaimStore delegate = new InMemorySettlementClaimStore(64, FIXED);
    boolean fenceThrows;
    boolean fenceLost;
    boolean marksThrow;
    boolean markSettledLosesTheRace;

    @Override
    public SettlementClaimResult claimSettlement(SettlementClaim claim) {
      return delegate.claimSettlement(claim);
    }

    @Override
    public boolean beginSubmission(String txHash, String ownerToken, String payer) {
      if (fenceThrows) {
        throw new IllegalStateException("store down");
      }
      return !fenceLost && delegate.beginSubmission(txHash, ownerToken, payer);
    }

    @Override
    public void markSubmitted(String txHash, String ownerToken) {
      if (marksThrow) {
        throw new IllegalStateException("store down");
      }
      delegate.markSubmitted(txHash, ownerToken);
    }

    @Override
    public void markSubmissionUnconfirmed(String txHash, String ownerToken) {
      if (marksThrow) {
        throw new IllegalStateException("store down");
      }
      delegate.markSubmissionUnconfirmed(txHash, ownerToken);
    }

    @Override
    public void markSubmissionObserved(String txHash) {
      delegate.markSubmissionObserved(txHash);
    }

    @Override
    public void markRejected(String txHash, String ownerToken) {
      delegate.markRejected(txHash, ownerToken);
    }

    @Override
    public boolean markSettled(String txHash, String ownerToken) {
      boolean settled = delegate.markSettled(txHash, ownerToken);
      return !markSettledLosesTheRace && settled;
    }

    @Override
    public Optional<SettlementClaimState> claimState(String txHash) {
      return delegate.claimState(txHash);
    }

    @Override
    public Optional<SettlementClaimDetails> claimDetails(String txHash) {
      return delegate.claimDetails(txHash);
    }

    @Override
    public void releaseClaim(String txHash, String ownerToken) {
      delegate.releaseClaim(txHash, ownerToken);
    }

    @Override
    public void releaseUnsent(String txHash, String ownerToken) {
      delegate.releaseUnsent(txHash, ownerToken);
    }
  }

  /** Forwards only the original methods: no fence, no binding, no recorded payer. */
  private static final class Legacy extends Fenced {
    @Override
    public boolean beginSubmission(String txHash, String ownerToken, String payer) {
      return true;
    }

    @Override
    public Optional<SettlementClaimDetails> claimDetails(String txHash) {
      Optional<SettlementClaimState> state = claimState(txHash);
      return state.map(s -> new SettlementClaimDetails(s, null, null));
    }

    @Override
    public void releaseUnsent(String txHash, String ownerToken) {
      releaseClaim(txHash, ownerToken);
    }
  }

  private Chain chain() {
    Chain chain = new Chain();
    chain.nonceRef = nonce;
    return chain;
  }

  private static ExactCardanoFacilitatorScheme scheme(CardanoChainBackend backend, SettlementClaimStore store) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .settlementStore(store).clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build());
  }

  private SettleResponse settle(ExactCardanoFacilitatorScheme scheme) {
    return scheme.settle(payload, requirements, FacilitatorContext.EMPTY);
  }

  private SettleResponse settle(ExactCardanoFacilitatorScheme scheme, PaymentRequirements req) {
    PaymentPayload p = new PaymentPayload(2, payload.resource(), payload.accepted(), payload.payload(), null);
    return scheme.settle(p, req, FacilitatorContext.EMPTY);
  }

  private PaymentRequirements depth(int confirmations) {
    return requirements.withExtra("confirmationPolicy", Map.of("l1Confirmations", confirmations));
  }

  // ---------------------------------------------------------------- D1: replay on fresh evidence

  @Test
  void aSameBindingReplayOfASettledPaymentSucceedsOnFreshEvidence() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    assertThat(settle(scheme).isPending()).isTrue();
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();
    chain.chain.include(tx, 3);

    assertThat(settle(scheme).success()).isTrue();
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aReplayAfterARollbackIsPendingAndSucceedsOnceReincluded() {
    Chain chain = chain();
    Fenced store = new Fenced();
    var scheme = scheme(chain, store);
    settle(scheme);
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();

    chain.chain.rollback(tx);
    assertThat(settle(scheme).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SETTLED);

    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aStricterReplayWaitsForItsOwnDepth() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    settle(scheme, depth(1));
    chain.chain.include(tx, 1);
    assertThat(settle(scheme, depth(1)).success()).isTrue();

    assertThat(settle(scheme, depth(3)).isPending()).isTrue();
    chain.chain.include(tx, 4);
    assertThat(settle(scheme, depth(3)).success()).isTrue();
  }

  @Test
  void aReplayWhoseEvidenceReadFailsIsPendingNeverSuccess() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    settle(scheme);
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();

    chain.evidenceFails = true;
    assertThat(settle(scheme).isPending()).isTrue();
  }

  @Test
  void aRolledBackReplayPastTheWindowWithProvenAbsenceIsExpired() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    settle(scheme);
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();
    chain.chain.rollback(tx);
    chain.chain.currentSlot(ttl + 1_000);

    SettleResponse expired = settle(scheme);

    assertThat(expired.success()).isFalse();
    assertThat(expired.extra()).containsEntry("status", "expired");
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aStoreWithoutBindingNeverReplaysASettledPayment() {
    Chain chain = chain();
    var scheme = scheme(chain, new Legacy());
    settle(scheme);
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();

    assertThat(settle(scheme).errorReason()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
  }

  @Test
  void concurrentRetriesAfterInclusionAllSucceedOrPendNeverDuplicate() throws Exception {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    settle(scheme);
    chain.chain.include(tx, 1);
    ExecutorService pool = Executors.newFixedThreadPool(6);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<SettleResponse>> retries = new ArrayList<>();
    for (int i = 0; i < 6; i++) {
      retries.add(pool.submit(() -> {
        start.await();
        return settle(scheme);
      }));
    }
    start.countDown();
    int successes = 0;
    for (Future<SettleResponse> retry : retries) {
      SettleResponse response = retry.get();
      if (response.success()) {
        successes++;
      } else {
        assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
      }
    }
    pool.shutdown();
    assertThat(successes).isPositive();
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aLostMarkSettledRaceSucceedsOnlyWhenTheStoreVouchesForTheBinding() {
    Chain chain = chain();
    Fenced store = new Fenced();
    var scheme = scheme(chain, store);
    settle(scheme);
    chain.chain.include(tx, 1);
    store.markSettledLosesTheRace = true;
    assertThat(settle(scheme).success()).isTrue();

    Chain other = chain();
    Legacy legacy = new Legacy();
    var unvouched = scheme(other, legacy);
    settle(unvouched);
    other.chain.include(tx, 1);
    legacy.markSettledLosesTheRace = true;
    assertThat(settle(unvouched).errorReason()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
  }

  // ---------------------------------------------------------------- I3: the fence

  @Test
  void aFenceLostToAReclaimIsPendingAndNeverBroadcasts() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.fenceLost = true;

    SettleResponse response = settle(scheme(chain, store));

    assertThat(response.isPending()).isTrue();
    assertThat(chain.chain.submissions()).isEmpty();
  }

  @Test
  void aFenceWriteFailureNeverBroadcastsAndReleasesTheClaim() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.fenceThrows = true;

    SettleResponse response = settle(scheme(chain, store));

    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_FAILED);
    assertThat(chain.chain.submissions()).isEmpty();
    assertThat(store.claimState(hash)).isEmpty();
  }

  @Test
  void aSubmittingClaimLeftByACrashResumesByEvidenceAndIsNeverRebroadcast() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "crashed", null, Long.MAX_VALUE, binding));
    store.beginSubmission(hash, "crashed", null);
    var scheme = scheme(chain, store);

    assertThat(settle(scheme).isPending()).isTrue();
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();
    assertThat(chain.chain.submissions()).isEmpty();
  }

  @Test
  void failedMarkWritesAfterSubmitLeaveTheClaimSubmittingAndTheRetryResumes() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.THROW_TRANSPORT);
    Fenced store = new Fenced();
    store.marksThrow = true;
    var scheme = scheme(chain, store);

    assertThat(settle(scheme).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SUBMITTING);
    assertThat(settle(scheme).isPending()).isTrue();
    assertThat(chain.chain.submissions()).hasSize(1);
  }

  // ---------------------------------------------------------------- I4: every claim result

  @Test
  void everyNonFreshClaimResultNeverBroadcasts() {
    List<SettlementClaimResult> results = new ArrayList<>(Arrays.asList(SettlementClaimResult.values()));
    results.remove(SettlementClaimResult.FRESH);
    results.add(null);
    for (SettlementClaimResult result : results) {
      Chain chain = chain();
      // The fence is granted, as a store without one grants it: the switch alone must refuse.
      Fenced store = new Fenced() {
        @Override
        public SettlementClaimResult claimSettlement(SettlementClaim claim) {
          return result;
        }

        @Override
        public boolean beginSubmission(String txHash, String ownerToken, String payer) {
          return true;
        }
      };

      SettleResponse response = settle(scheme(chain, store));

      assertThat(response.success()).as(String.valueOf(result)).isFalse();
      assertThat(chain.chain.submissions()).as(String.valueOf(result)).isEmpty();
    }
  }

  @Test
  void onlyFreshReachesTheBroadcast() {
    Chain chain = chain();
    settle(scheme(chain, new Fenced()));
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  // ---------------------------------------------------------------- I5: never sent

  @Test
  void aNeverSentSubmissionReleasesTheClaimSoTheRetryBroadcasts() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.NEVER_SENT);
    Fenced store = new Fenced();
    var scheme = scheme(chain, store);

    SettleResponse first = settle(scheme);

    assertThat(first.isPending()).isTrue();
    assertThat(first.errorMessage()).startsWith("the transaction was not sent");
    assertThat(store.claimState(hash)).isEmpty();
    chain.chain.submitMode(SubmitMode.ACCEPT);
    assertThat(settle(scheme).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SUBMITTED);
    assertThat(chain.chain.submissions()).hasSize(2);
  }

  @Test
  void aNeverSentSubmissionWithAFailingEvidenceReadIsStillReleased() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.NEVER_SENT);
    chain.evidenceFails = true;
    Fenced store = new Fenced();

    assertThat(settle(scheme(chain, store)).isPending()).isTrue();
    assertThat(store.claimState(hash)).isEmpty();
  }

  @Test
  void aNeverSentErrorWithTheTransactionVisibleIsTreatedAsBroadcast() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.NEVER_SENT);
    chain.forcedEvidence = new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, -1);
    Fenced store = new Fenced();

    assertThat(settle(scheme(chain, store)).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SUBMITTED);
  }

  @Test
  void aContradictoryNeverSentAndDefinitiveClassificationIsUnknown() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.NEVER_SENT);
    chain.definitive = true;
    Fenced store = new Fenced();

    assertThat(settle(scheme(chain, store)).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SUBMITTED);
  }

  @Test
  void aBackendWithoutTheCapabilityKeepsTheClaimAndNeverRebroadcasts() {
    Chain chain = chain();
    chain.chain.submitMode(SubmitMode.NEVER_SENT);
    chain.neverSentCapable = false;
    Fenced store = new Fenced();
    var scheme = scheme(chain, store);

    assertThat(settle(scheme).isPending()).isTrue();
    assertThat(store.claimState(hash)).contains(SettlementClaimState.SUBMITTED);
    chain.chain.submitMode(SubmitMode.ACCEPT);
    settle(scheme);
    assertThat(chain.chain.submissions()).hasSize(1);
  }

  // ---------------------------------------------------------------- I8: binding

  @Test
  void aSubmittedClaimIsNotResumedForAnotherResource() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    assertThat(settle(scheme).isPending()).isTrue();
    PaymentPayload elsewhere =
        new PaymentPayload(2, ResourceInfo.of("https://elsewhere.example/b"), payload.accepted(), payload.payload(), null);

    SettleResponse response = scheme.settle(elsewhere, requirements, FacilitatorContext.EMPTY);

    assertThat(response.errorReason()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
    assertThat(chain.chain.submissions()).containsExactly(tx);
    assertThat(scheme.verify(elsewhere, requirements, FacilitatorContext.EMPTY).invalidReason())
        .isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
  }

  @Test
  void anInFlightClaimWithAnotherBindingIsADuplicateNotPending() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "other", null, Long.MAX_VALUE,
        new SettlementBinding("f".repeat(64), java.util.Set.of())));

    assertThat(settle(scheme(chain, store)).errorReason()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
    assertThat(chain.chain.submissions()).isEmpty();
  }

  // ---------------------------------------------------------------- N3: the recorded payer

  @Test
  void theRecordedPayerIsUsedWhenTheNonceOwnerIsUnavailable() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    SettleResponse first = settle(scheme);
    assertThat(first.isPending()).isTrue();
    chain.chain.include(tx, 1);
    chain.nonceLookupFails = true;

    SettleResponse retry = settle(scheme);

    assertThat(retry.success()).isTrue();
    assertThat(retry.payer()).isEqualTo(first.payer());
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aRecordedPayerThatDiffersFromTheNonceOwnerNeverSettles() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "earlier", null, Long.MAX_VALUE, binding));
    store.beginSubmission(hash, "earlier", OTHER_PAYER);
    store.markSubmitted(hash, "earlier");
    chain.chain.include(tx, 1);
    var scheme = scheme(chain, store);

    assertThat(settle(scheme).errorReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
    VerifyResponse verdict = scheme.verify(payload, requirements, FacilitatorContext.EMPTY);
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void anUnwitnessedNonceOwnerNeverSettlesOnResume() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "earlier", null, Long.MAX_VALUE, binding));
    store.markSubmitted(hash, "earlier");
    chain.chain.include(tx, 1);
    chain.nonceOwner = OTHER_PAYER;

    assertThat(settle(scheme(chain, store)).errorReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void withoutRecordAndOwnerTheRetryStaysPending() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "earlier", null, Long.MAX_VALUE, binding));
    store.markSubmitted(hash, "earlier");
    chain.chain.include(tx, 1);
    chain.nonceLookupFails = true;

    assertThat(settle(scheme(chain, store)).isPending()).isTrue();
  }

  @Test
  void anOverrideReturningNoPayerStillSettlesOnRetry() {
    Chain chain = chain();
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .settlementStore(new Fenced()).clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build()) {
      @Override
      protected VerifyResponse verifyPayment(PaymentPayload p, PaymentRequirements r) {
        VerifyResponse verdict = super.verifyPayment(p, r);
        return verdict.isValid() ? VerifyResponse.valid(null) : verdict;
      }
    };
    assertThat(settle(scheme).isPending()).isTrue();
    chain.chain.include(tx, 1);

    SettleResponse retry = settle(scheme);

    assertThat(retry.success()).isTrue();
    assertThat(retry.payer()).isNotBlank();
  }

  // ---------------------------------------------------------------- review additions (S2)

  @Test
  void aScriptOwnedPayerNeedsAScriptWitnessOnResume() {
    Chain chain = chain();
    Fenced store = new Fenced();
    store.claimSettlement(new SettlementClaim(hash, "earlier", null, Long.MAX_VALUE, binding));
    store.markSubmitted(hash, "earlier");
    chain.chain.include(tx, 1);
    // The fixture transaction carries key witnesses only.
    chain.nonceOwner = CardanoAddresses.enterpriseScriptAddress("cardano:preprod",
        "ab".repeat(28));

    assertThat(settle(scheme(chain, store)).errorReason()).isEqualTo(CardanoErrors.TRANSACTION_PHASE1_INVALID);
  }

  @Test
  void aConcurrentPreFenceLoserIsPendingAndNothingIsSubmittedTwice() throws Exception {
    CountDownLatch inSubmit = new CountDownLatch(1);
    CountDownLatch release = new CountDownLatch(1);
    Chain chain = new Chain() {
      @Override
      public SubmissionResult submitTransaction(String signed, String network) {
        inSubmit.countDown();
        try {
          release.await();
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
        return super.submitTransaction(signed, network);
      }
    };
    chain.nonceRef = nonce;
    var scheme = scheme(chain, new Fenced());
    ExecutorService pool = Executors.newSingleThreadExecutor();
    Future<SettleResponse> first = pool.submit(() -> settle(scheme));
    inSubmit.await();

    SettleResponse loser = settle(scheme);
    release.countDown();
    first.get();
    pool.shutdown();

    assertThat(loser.isPending()).isTrue();
    assertThat(chain.chain.submissions()).containsExactly(tx);
  }

  @Test
  void aLegacyDigestRecordStillMatchesAndResumes() {
    Chain chain = chain();
    Fenced store = new Fenced();
    PaymentRequirements policy = depth(1);
    String legacy = SettlementBinding.legacyDigest(policy, payload.resource());
    assertThat(legacy).isNotEqualTo(SettlementBinding.digest(policy, payload.resource()));
    store.claimSettlement(new SettlementClaim(hash, "migrated", null, Long.MAX_VALUE,
        new SettlementBinding(legacy, java.util.Set.of())));
    store.beginSubmission(hash, "migrated", null);
    store.markSubmitted(hash, "migrated");
    chain.chain.include(tx, 1);

    assertThat(settle(scheme(chain, store), policy).success()).isTrue();
    assertThat(chain.chain.submissions()).isEmpty();
  }

  @Test
  void aReplayOfASettledPaymentWithAnotherBindingIsADuplicate() {
    Chain chain = chain();
    var scheme = scheme(chain, new Fenced());
    settle(scheme);
    chain.chain.include(tx, 1);
    assertThat(settle(scheme).success()).isTrue();
    PaymentPayload elsewhere =
        new PaymentPayload(2, ResourceInfo.of("https://elsewhere.example/b"), payload.accepted(), payload.payload(), null);

    assertThat(scheme.settle(elsewhere, requirements, FacilitatorContext.EMPTY).errorReason())
        .isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
  }
}
