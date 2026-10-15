package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Replay protection: a landed payment cannot be replayed. Public verify
 * never accepts ledger evidence as validity and refuses any transaction the claim store knows;
 * a settled transaction is terminal; the legitimate pending retry still succeeds exactly once.
 */
class ReplayGuardTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);


  /**
   * Broadcast records are retained until TTL + grace; this store clock is past
   * every fixture's retention, so the eviction scenarios below stay deterministic.
   */
  private static final java.time.Clock AFTER_RETENTION =
      java.time.Clock.fixed(java.time.Instant.ofEpochMilli(Long.MAX_VALUE / 2), java.time.ZoneOffset.UTC);

  private final JsonNode fixture = Vectors.fixture("01-default-happy");
  private final PaymentPayload payload = Vectors.payload(fixture.get("payload"));
  private final PaymentRequirements requirements = Vectors.requirements(fixture.get("requirements"));
  private final String tx = (String) payload.payload().get("transaction");
  private final String hash = CardanoTransactionDecoder.decode(tx).txHash();

  private static ExactCardanoFacilitatorScheme scheme(FakeChain chain, SettlementClaimStore store) {
    return new ExactCardanoFacilitatorScheme(
        chain,
        null,
        ExactCardanoFacilitatorOptions.builder()
            .clock(FIXED)
            .settlementStore(store)
            .confirmationTimeout(Duration.ofMillis(5))
            .confirmationPoll(Duration.ofMillis(1))
            .build());
  }

  private SettleResponse settle(ExactCardanoFacilitatorScheme scheme) {
    return scheme.settle(payload, requirements, FacilitatorContext.EMPTY);
  }

  private VerifyResponse verify(ExactCardanoFacilitatorScheme scheme) {
    return scheme.verify(payload, requirements, FacilitatorContext.EMPTY);
  }

  /** Settles the fixture payment to success through the legitimate pending retry. */
  private SettleResponse settleToSuccess(FakeChain chain, ExactCardanoFacilitatorScheme scheme) {
    assertThat(settle(scheme).isPending()).isTrue();
    chain.include(tx, 1);
    SettleResponse done = settle(scheme);
    assertThat(done.success()).isTrue();
    return done;
  }

  @Test
  void aSettledPaymentNoLongerVerifies() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = scheme(chain, new InMemorySettlementClaimStore());
    settleToSuccess(chain, scheme);

    VerifyResponse replay = verify(scheme);

    assertThat(replay.isValid()).isFalse();
    assertThat(replay.invalidReason()).isEqualTo("duplicate_settlement");
  }

  @Test
  void aSettledPaymentCannotBeSettledAgain() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var store = new InMemorySettlementClaimStore();
    var scheme = scheme(chain, store);
    settleToSuccess(chain, scheme);

    SettleResponse replay = settle(scheme);

    // Deliberate requirement change (D1, user-approved 2026-10-14): was duplicate_settlement; a
    // same-binding replay of a settled payment succeeds again on freshly read evidence and is
    // never broadcast again.
    assertThat(replay.success()).isTrue();
    assertThat(store.claimSettlement(new SettlementClaim(hash, "probe", null, null))).isEqualTo(SettlementClaimResult.SETTLED);
    assertThat(chain.submissions()).containsExactly(tx);
  }

  @Test
  void aPaymentClaimedElsewhereDoesNotVerify() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var store = new InMemorySettlementClaimStore();
    var scheme = scheme(chain, store);
    store.claimSettlement(new SettlementClaim(hash, "worker-a", null, null));
    assertThat(verify(scheme).invalidReason()).isEqualTo("duplicate_settlement");

    store.markSubmitted(hash, "worker-a");
    // A submitted claim verifies as broadcast (the spec's paid retry after pending) only with
    // proof of the broadcast; without ledger or mempool evidence it stays pending.
    assertThat(verify(scheme).invalidReason()).isEqualTo("settlement_pending");
    chain.include(tx, 0);
    assertThat(verify(scheme).isValid()).isTrue();
  }

  @Test
  void afterEvictionALandedPaymentFailsInsteadOfBeingDeliveredAgain() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy");
    var scheme = scheme(chain, new InMemorySettlementClaimStore(1, AFTER_RETENTION));
    settleToSuccess(chain, scheme);
    JsonNode other = Vectors.fixture("01e-native-asset-happy");
    scheme.settle(Vectors.payload(other.get("payload")), Vectors.requirements(other.get("requirements")), FacilitatorContext.EMPTY);

    VerifyResponse verified = verify(scheme);
    SettleResponse settled = settle(scheme);

    assertThat(verified.invalidReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(settled.success()).isFalse();
    assertThat(settled.errorReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(chain.submissions().stream().filter(tx::equals).count()).isEqualTo(1);
  }

  @Test
  void theLegitimatePendingRetryStillSucceedsExactlyOnce() throws Exception {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = scheme(chain, new InMemorySettlementClaimStore());
    assertThat(settle(scheme).isPending()).isTrue();
    chain.include(tx, 1);

    ExecutorService pool = Executors.newFixedThreadPool(4);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<SettleResponse>> retries = new ArrayList<>();
    for (int i = 0; i < 4; i++) {
      retries.add(
          pool.submit(
              () -> {
                start.await();
                return settle(scheme);
              }));
    }
    start.countDown();
    int successes = 0;
    for (Future<SettleResponse> r : retries) {
      SettleResponse response = r.get();
      if (response.success()) {
        successes++;
      } else {
        // Deliberate requirement change (D1/D3, user-approved 2026-10-14): was
        // duplicate_settlement; a retry that loses the race is pending, never a duplicate.
        assertThat(response.errorReason()).isEqualTo("settlement_pending");
      }
    }
    pool.shutdown();
    // Was exactly one success; every retry re-read the evidence, so each may report it (D1).
    assertThat(successes).isGreaterThanOrEqualTo(1);
    assertThat(chain.submissions()).containsExactly(tx);
  }

  @Test
  void afterEvictionAMempoolRetryResubmitsIdenticallyAndConfirmsOnItsRetainedClaim() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy");
    var scheme = scheme(chain, new InMemorySettlementClaimStore(1, AFTER_RETENTION));
    assertThat(settle(scheme).isPending()).isTrue();
    JsonNode other = Vectors.fixture("01e-native-asset-happy");
    scheme.settle(Vectors.payload(other.get("payload")), Vectors.requirements(other.get("requirements")), FacilitatorContext.EMPTY);

    assertThat(settle(scheme).isPending()).isTrue();
    chain.include(tx, 1);
    SettleResponse done = settle(scheme);

    assertThat(done.success()).isTrue();
    assertThat(chain.submissions().stream().filter(tx::equals).count()).isEqualTo(2);
  }

  @Test
  void ledgerEvidenceAloneNeverMakesAPublicVerifyValid() {
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    chain.include(tx, 3);
    var scheme = scheme(chain, new InMemorySettlementClaimStore());

    assertThat(verify(scheme).invalidReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
  }
}
