package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;

/**
 * A settle answers within its deadline, and resuming a broadcast transaction never fails a
 * payment that may have landed for a reason that depends on the moment of the re-check.
 */
class SettleDeadlineAndResumeTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final ProtocolParams PRICEY = Ccl.params(1_000_000, 44, 155381);

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

  /** Moves the clock while verification reads the protocol parameters. */
  private static final class SlowBackend extends StubBackend {
    final MovableClock clock;
    long advanceOnParameters;

    SlowBackend(MovableClock clock) {
      this.clock = clock;
    }

    @Override
    public ProtocolParams getProtocolParameters(String network) {
      clock.millis.addAndGet(advanceOnParameters);
      return super.getProtocolParameters(network);
    }
  }

  private final MovableClock clock = new MovableClock();
  private final SlowBackend backend = new SlowBackend(clock);

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

  private ExactCardanoFacilitatorScheme scheme(SettlementClaimStore store) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(clock)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(store)
        .build());
  }

  private static String hash(String tx) {
    return CardanoTransactionDecoder.decode(tx).txHash();
  }

  /** Broadcasts once, answered pending: the claim is SUBMITTED and bound. */
  private String broadcastPending(ExactCardanoFacilitatorScheme scheme) {
    String tx = tx();
    SettleResponse first = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(first.isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
    return tx;
  }

  // ---------------------------------------------------------------- resume (#15)

  @Test
  void aParameterChangeAfterBroadcastDoesNotFailAConfirmedPayment() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.parameters = PRICEY;
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));

    SettleResponse resumed = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(resumed.success()).isTrue();
    assertThat(resumed.payer()).isEqualTo(PAYER);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aParameterChangeWithoutEvidenceStaysPending() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.parameters = PRICEY;

    SettleResponse resumed = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(resumed.isPending()).isTrue();
    assertThat(resumed.errorMessage()).contains(CardanoErrors.MIN_UTXO_INSUFFICIENT);
  }

  @Test
  void withoutABindingAMomentaryFailureIsPendingNeverSuccess() {
    var store = new InMemorySettlementClaimStore();
    String tx = tx();
    store.claimSettlement(new SettlementClaim(hash(tx), "earlier", null, null));
    store.markSubmitted(hash(tx), "earlier");
    backend.parameters = PRICEY;
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));

    SettleResponse resumed = scheme(store).settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(resumed.isPending()).isTrue();
    assertThat(backend.submitted).isEmpty();
  }

  @Test
  void aRetryForAnotherNonceStillFails() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    Map<String, Object> p = new LinkedHashMap<>(payload(tx).payload());
    p.put("nonce", TxBuilder.hash32(0xbb) + "#0");
    PaymentPayload other = new PaymentPayload(2, null, requirements(), p, null);

    SettleResponse resumed = scheme.settle(other, requirements(), FacilitatorContext.EMPTY);

    assertThat(resumed.success()).isFalse();
    assertThat(resumed.isPending()).isFalse();
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aBoundPaidRetryVerifiesValidWhenTheRecheckFailsForTheMomentAndSettleLetsTheLedgerDecide() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.parameters = PRICEY;
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));

    VerifyResponse verdict = scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.isValid()).isTrue();
    assertThat(verdict.payer()).isEqualTo(PAYER);
    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  // ---------------------------------------------------------------- deadline (#6)

  @Test
  void aSettleThatRanOutOfTimeBeforeBroadcastSendsNothingAndTheRetryBroadcastsOnce() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = tx();
    backend.advanceOnParameters = ExactCardanoFacilitatorOptions.DEFAULT_SETTLE_TIMEOUT.toMillis() + 1;

    SettleResponse late = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(late.isPending()).isTrue();
    assertThat(late.transaction()).isEqualTo(hash(tx));
    assertThat(backend.submitted).isEmpty();

    backend.advanceOnParameters = 0;
    assertThat(scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void theConfirmationWaitEndsAtTheSettleDeadline() {
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(clock)
        .confirmationTimeout(Duration.ofSeconds(60))
        .confirmationPoll(Duration.ofMillis(5))
        .settlementStore(new InMemorySettlementClaimStore())
        .build());
    String tx = tx();
    // Verification eats all but 20 ms of the budget for starting chain calls (75 s less the 15 s
    // reserve for the call in flight).
    backend.advanceOnParameters = ExactCardanoFacilitatorOptions.DEFAULT_SETTLE_TIMEOUT.toMillis()
        - ExactCardanoFacilitatorOptions.DEFAULT_CHAIN_CALL_RESERVE.toMillis() - 20;

    SettleResponse response = assertTimeoutPreemptively(Duration.ofSeconds(5),
        () -> scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY));

    assertThat(response.isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void theSettleTimeoutDefaultsAndMustBePositive() {
    assertThat(ExactCardanoFacilitatorOptions.defaults().settleTimeout()).isEqualTo(Duration.ofSeconds(75));
    assertThat(ExactCardanoFacilitatorOptions.builder().settleTimeout(Duration.ofSeconds(30)).build()
        .settleTimeout()).isEqualTo(Duration.ofSeconds(30));
    assertThatThrownBy(() -> ExactCardanoFacilitatorOptions.builder().settleTimeout(Duration.ZERO).build())
        .isInstanceOf(IllegalArgumentException.class);
    assertThat(new ExactCardanoFacilitatorOptions(null, false, null, null, null, null, null, null, null, 0,
        null, null, 0).settleTimeout()).isEqualTo(Duration.ofSeconds(75));
  }
}
