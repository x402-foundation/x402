package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Method;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;

/**
 * The claim store's lifecycle: the broadcast fence (only a pre-fence claim can be reclaimed),
 * the never-sent release, the binding on every claim, and defaults that keep today's behaviour
 * for stores implementing only the original methods.
 */
class ClaimStoreLifecycleTest {

  private static final String TX = "aa".repeat(32);
  private static final SettlementBinding X = new SettlementBinding("x".repeat(64), Set.of());
  private static final SettlementBinding Y = new SettlementBinding("y".repeat(64), Set.of());

  /** A clock the test moves. */
  private static final class MutableClock extends Clock {
    long millis = 1_000_000L;

    @Override
    public ZoneId getZone() {
      return ZoneId.of("UTC");
    }

    @Override
    public Clock withZone(ZoneId zone) {
      return this;
    }

    @Override
    public Instant instant() {
      return Instant.ofEpochMilli(millis);
    }
  }

  private static SettlementClaim claim(String owner, SettlementBinding binding) {
    return new SettlementClaim(TX, owner, null, 9_000_000_000_000L, binding);
  }

  // ---------------------------------------------------------------- I3: fence and reclaim

  @Test
  void aStalePreFenceClaimIsReclaimedAndItsFormerOwnerCannotFence() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(16, clock, Duration.ofSeconds(1));
    assertThat(store.claimSettlement(claim("a", X))).isEqualTo(SettlementClaimResult.FRESH);
    clock.millis += 2_000;
    assertThat(store.claimSettlement(claim("b", X))).isEqualTo(SettlementClaimResult.FRESH);

    assertThat(store.beginSubmission(TX, "a", "payer")).isFalse();
    assertThat(store.beginSubmission(TX, "b", "payer")).isTrue();
    assertThat(store.claimState(TX)).contains(SettlementClaimState.SUBMITTING);
  }

  @Test
  void aClaimYoungerThanTheTimeoutIsNotReclaimed() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(16, clock, Duration.ofSeconds(10));
    store.claimSettlement(claim("a", X));
    clock.millis += 2_000;
    assertThat(store.claimSettlement(claim("b", X))).isEqualTo(SettlementClaimResult.IN_FLIGHT);
  }

  @Test
  void aSubmittingClaimIsNeverReclaimed() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(16, clock, Duration.ofSeconds(1));
    store.claimSettlement(claim("a", X));
    assertThat(store.beginSubmission(TX, "a", "payer")).isTrue();
    clock.millis += 3_600_000;
    assertThat(store.claimSettlement(claim("b", X))).isEqualTo(SettlementClaimResult.SUBMITTING);
    assertThat(store.claimDetails(TX)).contains(new SettlementClaimDetails(SettlementClaimState.SUBMITTING,
        X.digest(), "payer"));
  }

  @Test
  void withoutATimeoutNothingIsReclaimed() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(16, clock);
    store.claimSettlement(claim("a", X));
    clock.millis = Long.MAX_VALUE / 2;
    assertThat(store.claimSettlement(claim("b", X))).isEqualTo(SettlementClaimResult.IN_FLIGHT);
  }

  @Test
  void aStaleClaimIsNotReclaimedAcrossBindings() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(16, clock, Duration.ofSeconds(1));
    store.claimSettlement(claim("a", X));
    clock.millis += 2_000;
    assertThat(store.claimSettlement(claim("b", Y))).isEqualTo(SettlementClaimResult.BINDING_MISMATCH);
  }

  @Test
  void aSubmittingRecordIsRetainedUntilTtlPlusGraceThenEvictable() {
    MutableClock clock = new MutableClock();
    var store = new InMemorySettlementClaimStore(1, clock);
    store.claimSettlement(new SettlementClaim(TX, "a", null, clock.millis + 10_000, X));
    store.beginSubmission(TX, "a", null);
    String other = "bb".repeat(32);
    assertThat(store.claimSettlement(new SettlementClaim(other, "b", null, null, X)))
        .isEqualTo(SettlementClaimResult.CAPACITY_EXCEEDED);
    clock.millis += 10_000;
    assertThat(store.claimSettlement(new SettlementClaim(other, "b", null, null, X)))
        .isEqualTo(SettlementClaimResult.FRESH);
    assertThat(store.claimState(TX)).isEmpty();
  }

  @Test
  void aBlankPayerIsRecordedAsUnknown() {
    var store = new InMemorySettlementClaimStore();
    store.claimSettlement(claim("a", X));
    store.beginSubmission(TX, "a", "");
    assertThat(store.claimDetails(TX).orElseThrow().payer()).isNull();
  }

  // ---------------------------------------------------------------- I5: never sent

  @Test
  void aNeverSentClaimIsReleasedOnlyByItsOwnerAndOnlyBeforeAnOutcome() {
    var store = new InMemorySettlementClaimStore();
    store.claimSettlement(new SettlementClaim(TX, "a", "terms", null, X));
    store.beginSubmission(TX, "a", "payer");
    store.releaseUnsent(TX, "intruder");
    assertThat(store.claimState(TX)).contains(SettlementClaimState.SUBMITTING);
    store.releaseUnsent(TX, "a");
    assertThat(store.claimState(TX)).isEmpty();
    // The terms binding went with it.
    assertThat(store.claimSettlement(new SettlementClaim("cc".repeat(32), "c", "terms", null, X)))
        .isEqualTo(SettlementClaimResult.FRESH);

    for (int outcome = 0; outcome < 3; outcome++) {
      var recorded = new InMemorySettlementClaimStore();
      recorded.claimSettlement(claim("d", X));
      recorded.beginSubmission(TX, "d", null);
      switch (outcome) {
        case 0 -> recorded.markSubmitted(TX, "d");
        case 1 -> recorded.markRejected(TX, "d");
        default -> recorded.markSettled(TX, "d");
      }
      SettlementClaimState state = recorded.claimState(TX).orElseThrow();
      recorded.releaseUnsent(TX, "d");
      assertThat(recorded.claimState(TX)).as("outcome " + outcome).contains(state);
    }
  }

  @Test
  void outcomeMarksMoveOnlyAnUnresolvedClaim() {
    var rejected = new InMemorySettlementClaimStore();
    rejected.claimSettlement(claim("a", X));
    rejected.beginSubmission(TX, "a", null);
    rejected.markRejected(TX, "a");
    rejected.markSubmitted(TX, "a");
    rejected.markSubmissionUnconfirmed(TX, "a");
    assertThat(rejected.claimState(TX)).contains(SettlementClaimState.REJECTED);

    var submitted = new InMemorySettlementClaimStore();
    submitted.claimSettlement(claim("a", X));
    submitted.beginSubmission(TX, "a", null);
    submitted.markSubmitted(TX, "a");
    submitted.markRejected(TX, "a");
    assertThat(submitted.claimState(TX)).contains(SettlementClaimState.SUBMITTED);
  }

  // ---------------------------------------------------------------- I8: binding

  @Test
  void aClaimWithAnotherBindingIsAMismatchInEveryState() {
    for (int step = 0; step < 5; step++) {
      var store = new InMemorySettlementClaimStore();
      store.claimSettlement(claim("a", X));
      switch (step) {
        case 1 -> store.beginSubmission(TX, "a", null);
        case 2 -> store.markSubmitted(TX, "a");
        case 3 -> store.markSettled(TX, "a");
        case 4 -> store.markRejected(TX, "a");
        default -> { }
      }
      assertThat(store.claimSettlement(claim("b", Y))).as("step " + step)
          .isEqualTo(SettlementClaimResult.BINDING_MISMATCH);
    }
  }

  @Test
  void anUnboundClaimOrRecordIsNeverCompared() {
    var store = new InMemorySettlementClaimStore();
    store.claimSettlement(claim("a", X));
    assertThat(store.claimSettlement(claim("b", null))).isEqualTo(SettlementClaimResult.IN_FLIGHT);
    String other = "dd".repeat(32);
    store.claimSettlement(new SettlementClaim(other, "a", null, null));
    assertThat(store.claimSettlement(new SettlementClaim(other, "b", null, null, Y)))
        .isEqualTo(SettlementClaimResult.IN_FLIGHT);
    assertThat(store.claimDetails(other).orElseThrow().bindingDigest()).isNull();
  }

  @Test
  void aMatchingAlternateIsTheSameBinding() {
    var store = new InMemorySettlementClaimStore();
    store.claimSettlement(claim("a", X));
    SettlementBinding legacyAware = new SettlementBinding("z".repeat(64), Set.of(X.digest()));
    assertThat(store.claimSettlement(claim("b", legacyAware))).isEqualTo(SettlementClaimResult.IN_FLIGHT);
  }

  // ---------------------------------------------------------------- I7: defaults

  /** A store implementing only the original methods, recording what the defaults call. */
  private static final class OriginalOnlyStore implements SettlementClaimStore {
    final List<String> calls = new ArrayList<>();

    @Override
    public SettlementClaimResult claimSettlement(SettlementClaim claim) {
      return SettlementClaimResult.FRESH;
    }

    @Override
    public void markSubmitted(String txHash, String ownerToken) {}

    @Override
    public void markRejected(String txHash, String ownerToken) {}

    @Override
    public boolean markSettled(String txHash, String ownerToken) {
      return true;
    }

    @Override
    public Optional<SettlementClaimState> claimState(String txHash) {
      return Optional.of(SettlementClaimState.SUBMITTED);
    }

    @Override
    public void releaseClaim(String txHash, String ownerToken) {
      calls.add("releaseClaim " + ownerToken);
    }
  }

  @Test
  void theNewDefaultsKeepTodaysBehaviour() {
    OriginalOnlyStore store = new OriginalOnlyStore();
    assertThat(store.beginSubmission(TX, "a", "payer")).isTrue();
    store.releaseUnsent(TX, "a");
    assertThat(store.calls).containsExactly("releaseClaim a");
    assertThat(store.claimDetails(TX)).contains(new SettlementClaimDetails(SettlementClaimState.SUBMITTED, null, null));
    assertThat(new SettlementClaim(TX, "a", null, null).binding()).isNull();
    assertThat(new CardanoChainBackend() {
      @Override
      public org.x402.mechanisms.cardano.chain.UtxoSnapshot getUtxo(String ref, String network) {
        return null;
      }

      @Override
      public long getCurrentSlot(String network) {
        return 0;
      }

      @Override
      public com.bloxbean.cardano.client.api.model.ProtocolParams getProtocolParameters(String network) {
        return null;
      }

      @Override
      public org.x402.mechanisms.cardano.chain.SubmissionResult submitTransaction(String tx, String network) {
        return null;
      }
    }.isSubmissionNeverSent(new IllegalStateException())).isFalse();
  }

  @Test
  void theInMemoryStoreOverridesEveryDefaultMethod() throws Exception {
    for (Method m : SettlementClaimStore.class.getMethods()) {
      if (m.isDefault()) {
        Method impl = InMemorySettlementClaimStore.class.getMethod(m.getName(), m.getParameterTypes());
        assertThat(impl.getDeclaringClass()).as(m.getName()).isEqualTo(InMemorySettlementClaimStore.class);
      }
    }
  }
}
