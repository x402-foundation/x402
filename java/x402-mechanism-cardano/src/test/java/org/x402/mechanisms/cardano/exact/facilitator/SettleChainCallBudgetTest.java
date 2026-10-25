package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;

/**
 * Every chain call of a settle respects its call deadline (the expiry check's tip read included),
 * a resume against a provider that just failed the re-check costs one evidence read, not a whole
 * wait, and a definitive node rejection is recorded even when the deadline left no time for the
 * ledger read.
 */
class SettleChainCallBudgetTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final long BUDGET_MS = ExactCardanoFacilitatorOptions.DEFAULT_SETTLE_TIMEOUT.toMillis()
      - ExactCardanoFacilitatorOptions.DEFAULT_CHAIN_CALL_RESERVE.toMillis();

  /** A clock tests move by hand. */
  private static final class MovableClock extends Clock {
    final AtomicLong millis = new AtomicLong(Vectors.now());

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
      return Instant.ofEpochMilli(millis.get());
    }

    @Override
    public long millis() {
      return millis.get();
    }
  }

  /** Counts chain calls and moves the clock in them. */
  private static final class CountingBackend extends StubBackend {
    final MovableClock clock;
    final AtomicInteger evidenceReads = new AtomicInteger();
    final AtomicInteger indexedSlotReads = new AtomicInteger();
    long advanceOnEvidence;
    long advanceOnSubmit;
    long indexedSlot = -1;
    RuntimeException submitError;
    boolean definitive;

    CountingBackend(MovableClock clock) {
      this.clock = clock;
    }

    @Override
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      evidenceReads.incrementAndGet();
      clock.millis.addAndGet(advanceOnEvidence);
      return super.getTransactionEvidence(txHash, network);
    }

    @Override
    public long getIndexedSlot(String network) {
      indexedSlotReads.incrementAndGet();
      return indexedSlot < 0 ? super.getIndexedSlot(network) : indexedSlot;
    }

    @Override
    public SubmissionResult submitTransaction(String tx, String network) {
      clock.millis.addAndGet(advanceOnSubmit);
      if (submitError != null) {
        submitted.add(tx);
        throw submitError;
      }
      return super.submitTransaction(tx, network);
    }

    @Override
    public boolean isDefinitiveSubmissionRejection(Throwable error) {
      return definitive;
    }
  }

  private final MovableClock clock = new MovableClock();
  private final CountingBackend backend = new CountingBackend(clock);
  private final InMemorySettlementClaimStore store = new InMemorySettlementClaimStore();

  private String tx() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
  }

  private static PaymentRequirements requirements() {
    return new PaymentRequirements("exact", NETWORK, "lovelace", "2000000", PAY_TO, 600, Map.of());
  }

  private static PaymentPayload payload(String tx) {
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", NONCE);
    return new PaymentPayload(2, null, requirements(), p, null);
  }

  private ExactCardanoFacilitatorScheme scheme(Duration confirmationTimeout) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(clock)
        .confirmationTimeout(confirmationTimeout)
        .confirmationPoll(Duration.ofMillis(5))
        .settlementStore(store)
        .build());
  }

  private SettleResponse settle(ExactCardanoFacilitatorScheme scheme, String tx) {
    return scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
  }

  private static String hash(String tx) {
    return CardanoTransactionDecoder.decode(tx).txHash();
  }

  // ---------------------------------------------------------------- the expiry check (R2-6a)

  @Test
  void aResumeWhoseEvidenceReadEndsPastTheDeadlineDoesNotReadTheTipForExpiry() {
    var scheme = scheme(Duration.ofMillis(50));
    String tx = tx();
    assertThat(settle(scheme, tx).isPending()).isTrue();
    // The validity window has long closed by the provider's tip, and the transaction is absent:
    // with time left the resume would answer "expired". The evidence read itself uses the budget.
    backend.indexedSlot = backend.slot + 1_000_000;
    backend.advanceOnEvidence = BUDGET_MS;
    int slotReadsBefore = backend.indexedSlotReads.get();

    SettleResponse resumed = settle(scheme, tx);

    assertThat(resumed.isPending()).isTrue();
    assertThat(backend.indexedSlotReads.get()).isEqualTo(slotReadsBefore);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aResumeWithTimeLeftStillReportsAnExpiredTransaction() {
    var scheme = scheme(Duration.ofMillis(50));
    String tx = tx();
    assertThat(settle(scheme, tx).isPending()).isTrue();
    backend.indexedSlot = backend.slot + 1_000_000;

    SettleResponse resumed = settle(scheme, tx);

    assertThat(resumed.success()).isFalse();
    assertThat(resumed.extra()).containsEntry("status", "expired");
  }

  // ---------------------------------------------------------------- a failing provider (R2-15)

  @Test
  void aBoundResumeWhoseRecheckHitAFailingProviderReadsTheEvidenceOnceAndIsPending() {
    var scheme = scheme(Duration.ofMillis(300));
    String tx = tx();
    assertThat(settle(scheme, tx).isPending()).isTrue();
    backend.parametersError = new IllegalStateException("provider down");
    int readsBefore = backend.evidenceReads.get();

    SettleResponse resumed = settle(scheme, tx);

    assertThat(resumed.isPending()).isTrue();
    assertThat(resumed.errorMessage()).contains("chain lookup failed");
    assertThat(backend.evidenceReads.get() - readsBefore).isEqualTo(1);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void thatOneReadStillSettlesAPaymentTheLedgerShows() {
    var scheme = scheme(Duration.ofMillis(300));
    String tx = tx();
    assertThat(settle(scheme, tx).isPending()).isTrue();
    backend.parametersError = new IllegalStateException("provider down");
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    int readsBefore = backend.evidenceReads.get();

    SettleResponse resumed = settle(scheme, tx);

    assertThat(resumed.success()).isTrue();
    assertThat(resumed.payer()).isEqualTo(PAYER);
    assertThat(backend.evidenceReads.get() - readsBefore).isEqualTo(1);
  }

  @Test
  void aBoundResumeWhoseRecheckFailedForAnotherMomentaryReasonStillWaitsForTheLedger() {
    var scheme = scheme(Duration.ofMillis(300));
    String tx = tx();
    assertThat(settle(scheme, tx).isPending()).isTrue();
    // A protocol-parameter change is no provider failure: the wait polls as before.
    backend.parameters = org.x402.mechanisms.cardano.testing.Ccl.params(1_000_000, 44, 155381);
    int readsBefore = backend.evidenceReads.get();

    assertThat(settle(scheme, tx).isPending()).isTrue();
    assertThat(backend.evidenceReads.get() - readsBefore).isGreaterThan(1);
  }

  // ---------------------------------------------------------------- definitive rejection (R2-9)

  @Test
  void aDefinitiveRejectionAfterTheDeadlineIsRecordedWithoutALedgerRead() {
    var scheme = scheme(Duration.ofMillis(50));
    String tx = tx();
    backend.advanceOnSubmit = BUDGET_MS + 1_000;
    backend.submitError = new IllegalStateException("400 FeeTooSmallUTxO");
    backend.definitive = true;

    SettleResponse response = settle(scheme, tx);

    assertThat(response.success()).isFalse();
    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED);
    assertThat(backend.evidenceReads).hasValue(0);
    assertThat(store.claimState(hash(tx))).contains(SettlementClaimState.REJECTED);
  }

  @Test
  void anUnclassifiedFailureAfterTheDeadlineStaysPendingAndIsNeverSentAgain() {
    var scheme = scheme(Duration.ofMillis(50));
    String tx = tx();
    backend.advanceOnSubmit = BUDGET_MS + 1_000;
    backend.submitError = new IllegalStateException("read timed out");

    SettleResponse response = settle(scheme, tx);

    assertThat(response.isPending()).isTrue();
    assertThat(backend.evidenceReads).hasValue(0);
    assertThat(store.claimState(hash(tx))).isPresent()
        .get().isNotEqualTo(SettlementClaimState.REJECTED);
    backend.advanceOnSubmit = 0;
    backend.submitError = null;
    settle(scheme, tx);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aDefinitiveRejectionWhoseLedgerReadFailedStaysPending() {
    var scheme = scheme(Duration.ofMillis(50));
    String tx = tx();
    backend.submitError = new IllegalStateException("400 FeeTooSmallUTxO");
    backend.definitive = true;
    backend.evidenceError = new IllegalStateException("provider down");

    SettleResponse response = settle(scheme, tx);

    assertThat(response.isPending()).isTrue();
    assertThat(store.claimState(hash(tx))).isPresent()
        .get().isNotEqualTo(SettlementClaimState.REJECTED);
  }
}
