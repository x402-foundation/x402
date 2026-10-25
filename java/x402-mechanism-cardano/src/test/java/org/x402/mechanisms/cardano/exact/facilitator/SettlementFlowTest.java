package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.FakeChain.SubmitMode;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Settlement invariants S1–S8 and C1–C5: claim before broadcast, no
 * resubmission while a claim is retained, the submit-failure ladder, pending/expired outcomes,
 * and the post-eviction outcomes.
 */
class SettlementFlowTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private static ExactCardanoFacilitatorOptions.Builder fast() {
    return ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1));
  }

  private record Payment(PaymentPayload payload, PaymentRequirements requirements, String tx) {
    static Payment of(String fixtureId) {
      JsonNode f = Vectors.fixture(fixtureId);
      PaymentPayload payload = Vectors.payload(f.get("payload"));
      return new Payment(
          payload,
          Vectors.requirements(f.get("requirements")),
          (String) payload.payload().get("transaction"));
    }

    String hash() {
      return CardanoTransactionDecoder.decode(tx).txHash();
    }
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme, Payment p) {
    return scheme.settle(p.payload(), p.requirements(), FacilitatorContext.EMPTY);
  }

  @Test
  void pendingRetryResumesTheSameTransactionAndNeverResubmits() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());

    SettleResponse first = settle(scheme, p);
    assertThat(first.isPending()).isTrue();
    assertThat(first.transaction()).isEqualTo(p.hash());
    assertThat(first.extra()).containsEntry("status", "pending").containsEntry("transactionId", p.hash());

    chain.include(p.tx(), 0);
    SettleResponse second = settle(scheme, p);
    assertThat(second.isPending()).isTrue();
    assertThat(second.extra()).containsEntry("confirmations", 0);

    chain.include(p.tx(), 1);
    SettleResponse third = settle(scheme, p);
    assertThat(third.success()).isTrue();
    assertThat(third.extra()).containsEntry("status", "confirmed").containsEntry("confirmations", 1);
    assertThat(third.payer()).isNotBlank();

    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void aClaimInFlightElsewhereIsADuplicateAndNothingIsSubmitted() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var store = new InMemorySettlementClaimStore();
    assertThat(store.claimSettlement(new SettlementClaim(p.hash(), "other-worker", null, null)))
        .isEqualTo(SettlementClaimResult.FRESH);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().settlementStore(store).build());

    SettleResponse response = settle(scheme, p);

    assertThat(response.success()).isFalse();
    // Deliberate requirement change (D3, user-approved 2026-10-14): was duplicate_settlement; a
    // claim in flight elsewhere is pending, so the retry may still succeed.
    assertThat(response.errorReason()).isEqualTo("settlement_pending");
    assertThat(response.transaction()).isEqualTo(p.hash());
    assertThat(chain.submissions()).isEmpty();
  }

  @Test
  void aVerifyFailureReleasesTheClaimSoACorrectedAttemptCanStartOver() {
    Payment p = Payment.of("04-underpay");
    FakeChain chain = FakeChain.fromFixtures("04-underpay");
    var store = new InMemorySettlementClaimStore();
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().settlementStore(store).build());

    SettleResponse response = settle(scheme, p);

    assertThat(response.errorReason())
        .isEqualTo("invalid_exact_cardano_payload_amount_insufficient");
    assertThat(response.transaction()).isEqualTo(p.hash());
    assertThat(chain.submissions()).isEmpty();
    assertThat(store.claimSettlement(new SettlementClaim(p.hash(), "next", null, null)))
        .isEqualTo(SettlementClaimResult.FRESH);
  }

  @Test
  void aSubmitErrorForATransactionThatLandedResumesInsteadOfFailing() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(SubmitMode.THROW_AFTER_BROADCAST);
    var scheme =
        new ExactCardanoFacilitatorScheme(
            new LandsOnSubmit(chain, p.tx()), null, fast().build());

    SettleResponse response = settle(scheme, p);

    assertThat(response.success()).isTrue();
    assertThat(response.extra()).containsEntry("confirmations", 1);
  }

  @Test
  void anUnknownSubmitOutcomeRetainsTheClaimAndTheRetryNeverRebroadcasts() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(SubmitMode.THROW_TRANSPORT);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());

    SettleResponse first = settle(scheme, p);
    // Deliberate requirement change (D2, user-approved 2026-10-14): was
    // exact_cardano_settlement_failed; an unknown submit outcome is pending.
    assertThat(first.errorReason()).isEqualTo("settlement_pending");
    assertThat(first.errorMessage())
        .isEqualTo("the submission outcome is unknown; retry to resume: connection reset | socket closed");

    SettleResponse retry = settle(scheme, p);
    assertThat(retry.isPending()).isTrue();
    assertThat(chain.submissions()).hasSize(1);
  }

  @Test
  void aDefinitiveRejectionIsATombstone() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(SubmitMode.THROW_DEFINITIVE);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());

    assertThat(settle(scheme, p).errorReason())
        .isEqualTo("exact_cardano_settlement_definitively_rejected");
    SettleResponse retry = settle(scheme, p);
    assertThat(retry.errorReason()).isEqualTo("exact_cardano_settlement_definitively_rejected");
    assertThat(retry.errorMessage())
        .isEqualTo("this transaction was definitively rejected before ledger acceptance");
    assertThat(chain.submissions()).hasSize(1);
  }

  @Test
  void aSubmitterReportingAnotherHashIsAFailureThatKeepsTheClaim() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain =
        FakeChain.fromFixtures("01-default-happy").submitMode(SubmitMode.WRONG_HASH).evidenceCapable(false);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());
    // Without an evidence read only depth 0 can verify.
    PaymentRequirements zeroDepth =
        p.requirements().withExtra("confirmationPolicy", java.util.Map.of("l1Confirmations", 0));
    PaymentPayload payload = new PaymentPayload(2, p.payload().resource(), zeroDepth, p.payload().payload(), null);

    SettleResponse response = scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY);

    // Deliberate requirement change (wrong hash, user-approved 2026-10-14): was
    // exact_cardano_settlement_failed; the outcome is unknown, so it is pending.
    assertThat(response.errorReason()).isEqualTo("settlement_pending");
    assertThat(response.errorMessage()).isEqualTo("the submission outcome is unknown; retry to resume: "
        + "submitter returned transaction " + "00".repeat(32) + ", expected " + p.hash());
    assertThat(scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY).errorReason())
        .isNotEqualTo("duplicate_settlement");
    assertThat(chain.submissions()).hasSize(1);
  }

  @Test
  void aResumedTransactionPastItsValidityWindowIsATerminalExpiry() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());
    assertThat(settle(scheme, p).isPending()).isTrue();

    long ttl = CardanoTransactionDecoder.decode(p.tx()).ttlSlot().longValueExact();
    chain.currentSlot(ttl + 121);
    SettleResponse expired = settle(scheme, p);

    assertThat(expired.success()).isFalse();
    assertThat(expired.errorReason()).isEqualTo("exact_cardano_settlement_failed");
    assertThat(expired.errorMessage())
        .isEqualTo("the transaction's validity window closed before it was included");
    assertThat(expired.extra()).containsEntry("status", "expired");
    assertThat(chain.submissions()).hasSize(1);
  }

  @Test
  void theStoreAtCapacityWithEveryClaimInFlightRefusesWithoutSubmitting() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var store = new InMemorySettlementClaimStore(1);
    store.claimSettlement(new SettlementClaim("ab".repeat(32), "other", null, null));
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().settlementStore(store).build());

    SettleResponse response = settle(scheme, p);

    assertThat(response.errorReason()).isEqualTo("exact_cardano_settlement_failed");
    assertThat(response.errorMessage()).isEqualTo("the Cardano settlement store is at capacity");
    assertThat(chain.submissions()).isEmpty();
  }

  @Test
  void aSecondMasumiTransactionForTheSameTermsIsADuplicate() {
    Payment first = Payment.of("12-masumi-happy");
    Payment second = Payment.of("12b-masumi-second-transaction");
    FakeChain chain = FakeChain.fromFixtures("12-masumi-happy", "12b-masumi-second-transaction");
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().build());

    settle(scheme, first);
    SettleResponse duplicate = settle(scheme, second);

    assertThat(duplicate.errorReason()).isEqualTo("duplicate_settlement");
    assertThat(duplicate.errorMessage())
        .isEqualTo("termsDigest is already bound to another transaction");
    assertThat(chain.submissions()).containsExactly(first.tx());
  }

  @Test
  void mempoolPolicyWithAcceptMempoolSettlesOnTheNodesAcceptanceWithoutWaiting() {
    Payment p = Payment.of("11d-mempool-policy-with-acceptMempool");
    FakeChain chain = FakeChain.fromFixtures("11d-mempool-policy-with-acceptMempool");
    var scheme =
        new ExactCardanoFacilitatorScheme(
            chain,
            null,
            fast().acceptMempool(true).confirmationTimeout(Duration.ofHours(1)).build());

    SettleResponse response = assertTimeoutPreemptively(Duration.ofSeconds(10), () -> settle(scheme, p));

    assertThat(response.success()).isTrue();
    assertThat(response.extra()).containsEntry("status", "mempool").containsEntry("confirmations", -1);
  }

  @Test
  void theConfirmationWaitEndsOnAFixedClock() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var scheme =
        new ExactCardanoFacilitatorScheme(
            chain,
            null,
            ExactCardanoFacilitatorOptions.builder()
                .clock(FIXED)
                .confirmationTimeout(Duration.ofMillis(60))
                .confirmationPoll(Duration.ofMillis(20))
                .build());

    SettleResponse response = assertTimeoutPreemptively(Duration.ofSeconds(10), () -> settle(scheme, p));

    assertThat(response.isPending()).isTrue();
  }

  @Test
  void verifyNeverClaims() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    var store = new InMemorySettlementClaimStore();
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast().settlementStore(store).build());

    assertThat(scheme.verify(p.payload(), p.requirements(), FacilitatorContext.EMPTY).isValid()).isTrue();
    assertThat(scheme.verify(p.payload(), p.requirements(), FacilitatorContext.EMPTY).isValid()).isTrue();

    assertThat(store.claimSettlement(new SettlementClaim(p.hash(), "x", null, null)))
        .isEqualTo(SettlementClaimResult.FRESH);
  }

  // ---------------------------------------------------------------- post-eviction outcomes

  /** Fills a 1-entry store with another settled claim so the first claim is evicted. */
  /**
   * Broadcast records are retained until TTL + grace; this store clock is past
   * every fixture's retention, so the eviction scenarios below stay deterministic.
   */
  private static final java.time.Clock AFTER_RETENTION =
      java.time.Clock.fixed(java.time.Instant.ofEpochMilli(Long.MAX_VALUE / 2), java.time.ZoneOffset.UTC);

  private static void evict(ExactCardanoFacilitatorScheme scheme, String otherFixture) {
    SettleResponse other = settle(scheme, Payment.of(otherFixture));
    assertThat(other.transaction()).isNotBlank();
  }

  @Test
  void afterEvictionAMempoolTransactionIsResubmittedIdenticallyButASecondEvictionAfterInclusionFails() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy");
    var scheme =
        new ExactCardanoFacilitatorScheme(
            chain, null, fast().settlementStore(new InMemorySettlementClaimStore(1, AFTER_RETENTION)).build());

    assertThat(settle(scheme, p).isPending()).isTrue();
    evict(scheme, "01e-native-asset-happy");

    SettleResponse retry = settle(scheme, p);
    assertThat(retry.isPending()).isTrue();
    chain.include(p.tx(), 1);
    evict(scheme, "01e-native-asset-happy");
    SettleResponse done = settle(scheme, p);

    // Deliberate requirement change: was success; after the second eviction the
    // included transaction's nonce is spent and verify no longer accepts ledger evidence.
    assertThat(done.errorReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(chain.submissions().stream().filter(p.tx()::equals).count()).isGreaterThanOrEqualTo(2);
    assertThat(chain.submissions().stream().map(tx -> CardanoTransactionDecoder.decode(tx).txHash()))
        .allMatch(hash -> hash.equals(p.hash()) || hash.equals(Payment.of("01e-native-asset-happy").hash()));
  }

  @Test
  void afterEvictionAnIncludedTransactionFailsWithTheNonceSpent() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy");
    var scheme =
        new ExactCardanoFacilitatorScheme(
            chain, null, fast().settlementStore(new InMemorySettlementClaimStore(1, AFTER_RETENTION)).build());

    assertThat(settle(scheme, p).isPending()).isTrue();
    chain.include(p.tx(), 1);
    evict(scheme, "01e-native-asset-happy");

    SettleResponse retry = settle(scheme, p);

    // Deliberate requirement change: was success with a second (identical)
    // submission; now the spent nonce refuses the retry before anything is resubmitted.
    assertThat(retry.success()).isFalse();
    assertThat(retry.errorReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(retry.transaction()).isEqualTo(p.hash());
    assertThat(chain.submissions().stream().filter(p.tx()::equals).count()).isEqualTo(1);
  }

  @Test
  void afterEvictionWithoutEvidenceAnIncludedTransactionFailsVerifyAlthoughItLanded() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain =
        FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy")
            .evidenceCapable(false)
            .submitMode(SubmitMode.ACCEPT_CONFIRMED);
    var scheme =
        new ExactCardanoFacilitatorScheme(
            chain, null, fast().settlementStore(new InMemorySettlementClaimStore(1, AFTER_RETENTION)).build());
    PaymentRequirements zeroDepth =
        p.requirements().withExtra("confirmationPolicy", java.util.Map.of("l1Confirmations", 0));
    PaymentPayload payload =
        new PaymentPayload(2, p.payload().resource(), zeroDepth, p.payload().payload(), null);

    SettleResponse first = scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY);
    assertThat(first.success()).isTrue();
    chain.include(p.tx(), 1);
    evict(scheme, "01e-native-asset-happy");

    SettleResponse retry = scheme.settle(payload, zeroDepth, FacilitatorContext.EMPTY);

    assertThat(retry.success()).isFalse();
    assertThat(retry.errorReason()).isEqualTo("invalid_exact_cardano_payload_nonce_not_on_chain");
    assertThat(chain.submissions().stream().filter(p.tx()::equals).count()).isEqualTo(1);
  }

  /** Reports the transaction as included the moment it is submitted (then throws). */
  private static final class LandsOnSubmit
      implements org.x402.mechanisms.cardano.chain.CardanoChainBackend {
    private final FakeChain chain;
    private final String tx;

    LandsOnSubmit(FakeChain chain, String tx) {
      this.chain = chain;
      this.tx = tx;
    }

    @Override
    public org.x402.mechanisms.cardano.chain.UtxoSnapshot getUtxo(String ref, String network) {
      return chain.getUtxo(ref, network);
    }

    @Override
    public long getCurrentSlot(String network) {
      return chain.getCurrentSlot(network);
    }

    @Override
    public com.bloxbean.cardano.client.api.model.ProtocolParams getProtocolParameters(String network) {
      return chain.getProtocolParameters(network);
    }

    @Override
    public org.x402.mechanisms.cardano.chain.SubmissionResult submitTransaction(
        String signed, String network) {
      try {
        return chain.submitTransaction(signed, network);
      } finally {
        chain.include(tx, 1);
      }
    }

    @Override
    public boolean supportsTransactionEvidence() {
      return true;
    }

    @Override
    public org.x402.mechanisms.cardano.chain.SettlementEvidence getTransactionEvidence(
        String txHash, String network) {
      return chain.getTransactionEvidence(txHash, network);
    }
  }
}
