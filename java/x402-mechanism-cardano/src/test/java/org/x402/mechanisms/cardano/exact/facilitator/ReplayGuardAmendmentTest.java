package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
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
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoNetworks;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Replay-guard amendments, written before the fixes:
 * the spec's client paid retry after a pending outcome still verifies; a failing claim store
 * fails public verify closed; submitted and settled claims are retained until the transaction's
 * TTL plus grace; evidence with a {@code null} status is
 * unknown.
 */
class ReplayGuardAmendmentTest {

  private static final long NOW = Vectors.now();
  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(NOW), ZoneOffset.UTC);

  /** A clock tests can move. */
  static final class MutableClock extends Clock {
    long millis;

    MutableClock(long millis) {
      this.millis = millis;
    }

    @Override
    public ZoneId getZone() {
      return ZoneOffset.UTC;
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

  private record Payment(PaymentPayload payload, PaymentRequirements requirements, String tx, String hash, long ttlMs) {
    static Payment of(String id) {
      JsonNode f = Vectors.fixture(id);
      PaymentPayload p = Vectors.payload(f.get("payload"));
      PaymentRequirements r = Vectors.requirements(f.get("requirements"));
      String tx = (String) p.payload().get("transaction");
      var decoded = CardanoTransactionDecoder.decode(tx);
      long ttlMs = CardanoNetworks.slotToPosixMs(r.network(), decoded.ttlSlot()).longValueExact();
      return new Payment(p, r, tx, decoded.txHash(), ttlMs);
    }
  }

  private static ExactCardanoFacilitatorScheme scheme(FakeChain chain, SettlementClaimStore store, boolean acceptMempool) {
    return new ExactCardanoFacilitatorScheme(
        chain,
        null,
        ExactCardanoFacilitatorOptions.builder()
            .clock(FIXED)
            .acceptMempool(acceptMempool)
            .settlementStore(store)
            .confirmationTimeout(Duration.ofMillis(5))
            .confirmationPoll(Duration.ofMillis(1))
            .build());
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme s, Payment p) {
    return s.settle(p.payload(), p.requirements(), FacilitatorContext.EMPTY);
  }

  private static VerifyResponse verify(ExactCardanoFacilitatorScheme s, Payment p) {
    return s.verify(p.payload(), p.requirements(), FacilitatorContext.EMPTY);
  }

  @Test
  void theClientsPaidRetryAfterAPendingOutcomeVerifiesAndSettlesOnce() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var s = scheme(chain, new InMemorySettlementClaimStore(16, FIXED), false);

    assertThat(settle(s, p).isPending()).isTrue();
    assertThat(settle(s, p).isPending()).isTrue(); // core's one in-process retry

    // The server surfaced the pending outcome as 402; the client resends the same signature.
    VerifyResponse retried = verify(s, p);
    assertThat(retried.isValid()).as(String.valueOf(retried.invalidReason())).isTrue();
    chain.include(p.tx(), 1);
    assertThat(settle(s, p).success()).isTrue();

    assertThat(verify(s, p).invalidReason()).isEqualTo("duplicate_settlement");
    // Deliberate requirement change (D1, user-approved 2026-10-14): was duplicate_settlement; a
    // same-binding settle replay succeeds again on re-read evidence, never rebroadcasting.
    assertThat(settle(s, p).success()).isTrue();
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void concurrentReplaysWhileSubmittedYieldExactlyOneSuccess() throws Exception {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var s = scheme(chain, new InMemorySettlementClaimStore(16, FIXED), false);
    assertThat(settle(s, p).isPending()).isTrue();
    chain.include(p.tx(), 1);

    ExecutorService pool = Executors.newFixedThreadPool(6);
    CountDownLatch start = new CountDownLatch(1);
    List<Future<SettleResponse>> requests = new ArrayList<>();
    for (int i = 0; i < 6; i++) {
      requests.add(
          pool.submit(
              () -> {
                start.await();
                VerifyResponse v = verify(s, p);
                return v.isValid() ? settle(s, p) : null;
              }));
    }
    start.countDown();
    int successes = 0;
    for (Future<SettleResponse> r : requests) {
      SettleResponse response = r.get();
      if (response != null && response.success()) {
        successes++;
      } else if (response != null) {
        // Deliberate requirement change (D1, user-approved 2026-10-14): was duplicate_settlement.
        assertThat(response.isPending()).as(response.errorReason()).isTrue();
      }
    }
    pool.shutdown();
    // Was exactly one success; every settle re-read the evidence, so each may report it (D1).
    assertThat(successes).isGreaterThanOrEqualTo(1);
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void anInFlightOrRejectedClaimStillRefusesPublicVerify() {
    Payment p = Payment.of("01-default-happy");
    var store = new InMemorySettlementClaimStore(16, FIXED);
    var s = scheme(FakeChain.fromFixtures("01-default-happy"), store, false);
    store.claimSettlement(new SettlementClaim(p.hash(), "other", null, null));
    assertThat(store.claimState(p.hash())).contains(SettlementClaimState.IN_FLIGHT);
    assertThat(verify(s, p).invalidReason()).isEqualTo("duplicate_settlement");
    store.markRejected(p.hash(), "other");
    assertThat(store.claimState(p.hash())).contains(SettlementClaimState.REJECTED);
    assertThat(verify(s, p).invalidReason()).isEqualTo("duplicate_settlement");
    assertThat(store.claimState("00".repeat(32))).isEmpty();
  }

  @Test
  void aFailingClaimStoreFailsPublicVerifyClosed() {
    Payment p = Payment.of("01-default-happy");
    InMemorySettlementClaimStore inner = new InMemorySettlementClaimStore(16, FIXED);
    SettlementClaimStore broken =
        new SettlementClaimStore() {
          @Override
          public SettlementClaimResult claimSettlement(SettlementClaim claim) {
            return inner.claimSettlement(claim);
          }

          @Override
          public void markSubmitted(String txHash, String ownerToken) {
            inner.markSubmitted(txHash, ownerToken);
          }

          @Override
          public void markRejected(String txHash, String ownerToken) {
            inner.markRejected(txHash, ownerToken);
          }

          @Override
          public boolean markSettled(String txHash, String ownerToken) {
            return inner.markSettled(txHash, ownerToken);
          }

          @Override
          public Optional<SettlementClaimState> claimState(String txHash) {
            throw new IllegalStateException("redis down");
          }

          @Override
          public void releaseClaim(String txHash, String ownerToken) {
            inner.releaseClaim(txHash, ownerToken);
          }
        };
    var s = scheme(FakeChain.fromFixtures("01-default-happy"), broken, false);

    VerifyResponse v = verify(s, p);

    assertThat(v.isValid()).isFalse();
    assertThat(v.invalidReason()).isEqualTo("exact_cardano_settlement_failed");
    assertThat(v.invalidMessage()).isEqualTo("settlement store unavailable");
  }

  @Test
  void aMempoolSettledPaymentIsRetainedUntilItsTtlPassesSoItCannotBeReplayed() {
    Payment p = Payment.of("11d-mempool-policy-with-acceptMempool");
    Payment other = Payment.of("01e-native-asset-happy");
    MutableClock storeClock = new MutableClock(NOW);
    var store = new InMemorySettlementClaimStore(1, storeClock);
    FakeChain chain = FakeChain.fromFixtures("11d-mempool-policy-with-acceptMempool", "01e-native-asset-happy");
    var s = scheme(chain, store, true);
    assertThat(settle(s, p).success()).isTrue();

    SettleResponse pressure = settle(s, other);
    assertThat(pressure.success()).isFalse();
    assertThat(pressure.errorReason()).isEqualTo("exact_cardano_settlement_failed");
    assertThat(verify(s, p).invalidReason()).isEqualTo("duplicate_settlement");
    // Deliberate requirement change (D1, user-approved 2026-10-14): was duplicate_settlement; the
    // replay re-reads the mempool evidence and succeeds without rebroadcasting.
    assertThat(settle(s, p).success()).isTrue();
    assertThat(chain.submissions()).containsExactly(p.tx());

    storeClock.millis = p.ttlMs() + 120_000;
    assertThat(store.claimSettlement(new SettlementClaim(other.hash(), "o", null, null))).isEqualTo(SettlementClaimResult.FRESH);
    assertThat(store.claimState(p.hash())).isEmpty();
  }

  @Test
  void aSubmittedClaimSurvivesCapacityPressureSoItsOnlySuccessIsReported() {
    Payment p = Payment.of("01-default-happy");
    Payment other = Payment.of("01e-native-asset-happy");
    var store = new InMemorySettlementClaimStore(1, FIXED);
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy");
    var s = scheme(chain, store, false);
    assertThat(settle(s, p).isPending()).isTrue();

    assertThat(settle(s, other).errorReason()).isEqualTo("exact_cardano_settlement_failed");
    chain.include(p.tx(), 1);
    SettleResponse done = settle(s, p);

    assertThat(done.success()).isTrue();
    assertThat(store.claimState(p.hash())).contains(SettlementClaimState.SETTLED);
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void storeRetentionRules() {
    MutableClock clock = new MutableClock(1_000);
    var store = new InMemorySettlementClaimStore(1, clock);
    assertThat(store.claimSettlement(new SettlementClaim("a", "o", null, 5_000L))).isEqualTo(SettlementClaimResult.FRESH);
    store.markSubmitted("a", "o");
    assertThat(store.claimSettlement(new SettlementClaim("b", "o", null, 5_000L)))
        .isEqualTo(SettlementClaimResult.CAPACITY_EXCEEDED);
    assertThat(store.markSettled("a", "x")).isTrue();
    assertThat(store.claimSettlement(new SettlementClaim("b", "o", null, 5_000L)))
        .isEqualTo(SettlementClaimResult.CAPACITY_EXCEEDED);
    clock.millis = 5_000;
    assertThat(store.claimSettlement(new SettlementClaim("b", "o", null, null))).isEqualTo(SettlementClaimResult.FRESH);
    assertThat(store.markSettled("a", "o")).isFalse(); // evicted: never re-created as settled

    // Without a known expiry a broadcast claim is never evicted; a rejected one always is.
    store.markSubmitted("b", "o");
    clock.millis = Long.MAX_VALUE;
    assertThat(store.claimSettlement(new SettlementClaim("c", "o", null, null))).isEqualTo(SettlementClaimResult.CAPACITY_EXCEEDED);
    var rejected = new InMemorySettlementClaimStore(1, clock);
    rejected.claimSettlement(new SettlementClaim("r", "o", null, Long.MAX_VALUE));
    rejected.markRejected("r", "o");
    assertThat(rejected.claimSettlement(new SettlementClaim("s", "o", null, null))).isEqualTo(SettlementClaimResult.FRESH);
  }

  @Test
  void evidenceWithoutAStatusIsUnknown() {
    StubBackend nullStatus =
        new StubBackend() {
          @Override
          public SettlementEvidence getTransactionEvidence(String txHash, String network) {
            return new SettlementEvidence(null, 0);
          }
        };
    String payer = TxBuilder.walletAddress();
    String payTo = Payment.of("01-default-happy").requirements().payTo();
    String nonceHash = TxBuilder.hash32(0xaa);
    nullStatus.unspent(nonceHash + "#0", payer, 10_000_000, Map.of());
    String tx =
        TxBuilder.create()
            .input(nonceHash, 0)
            .output(payTo, 2_000_000, Map.of(), null, false)
            .output(payer, 7_800_000, Map.of(), null, false)
            .fee(200_000)
            .ttl(nullStatus.slot + 300)
            .signWith(TxBuilder.WALLET)
            .build();
    PaymentRequirements req = new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", payTo, 600, Map.of());
    PaymentPayload payload = new PaymentPayload(2, null, req, Map.of("transaction", tx, "nonce", nonceHash + "#0"), null);
    var s =
        new ExactCardanoFacilitatorScheme(
            nullStatus,
            null,
            ExactCardanoFacilitatorOptions.builder()
                .confirmationTimeout(Duration.ofMillis(5))
                .confirmationPoll(Duration.ofMillis(1))
                .build());

    SettleResponse response = s.settle(payload, req, FacilitatorContext.EMPTY);

    assertThat(response.isPending()).isTrue();
  }
}
