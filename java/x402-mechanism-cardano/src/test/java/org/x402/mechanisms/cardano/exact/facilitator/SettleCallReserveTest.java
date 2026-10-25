package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.mechanisms.cardano.chain.BlockfrostChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;

/**
 * A settle keeps the end of its timeout for the chain call in flight: neither the broadcast nor
 * an evidence read starts in that reserve, so the call that is running when the budget runs out
 * can still end before the settle must answer. Settings that would not do what they suggest are
 * logged.
 */
class SettleCallReserveTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final long SETTLE_MS = ExactCardanoFacilitatorOptions.DEFAULT_SETTLE_TIMEOUT.toMillis();
  private static final long RESERVE_MS = ExactCardanoFacilitatorOptions.DEFAULT_CHAIN_CALL_RESERVE.toMillis();

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

  /** Moves the clock in verification or in the submission, and counts evidence reads. */
  private static final class SlowBackend extends StubBackend {
    final MovableClock clock;
    long advanceOnParameters;
    long advanceOnSubmit;
    RuntimeException submitError;
    final AtomicInteger evidenceReads = new AtomicInteger();

    SlowBackend(MovableClock clock) {
      this.clock = clock;
    }

    @Override
    public ProtocolParams getProtocolParameters(String network) {
      clock.millis.addAndGet(advanceOnParameters);
      return super.getProtocolParameters(network);
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
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      evidenceReads.incrementAndGet();
      return super.getTransactionEvidence(txHash, network);
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
        .confirmationTimeout(Duration.ofMillis(50))
        .confirmationPoll(Duration.ofMillis(5))
        .settlementStore(store)
        .build());
  }

  private SettleResponse settle(ExactCardanoFacilitatorScheme scheme, String tx) {
    return scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
  }

  // ---------------------------------------------------------------- the broadcast

  @Test
  void aSettleWithOnlyTheReserveLeftDoesNotBroadcastAndTheRetryBroadcastsOnce() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = tx();
    backend.advanceOnParameters = SETTLE_MS - RESERVE_MS;

    SettleResponse late = settle(scheme, tx);

    assertThat(late.isPending()).isTrue();
    assertThat(backend.submitted).isEmpty();
    backend.advanceOnParameters = 0;
    assertThat(settle(scheme, tx).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aSettleJustBeforeTheReserveStillBroadcasts() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = tx();
    backend.advanceOnParameters = SETTLE_MS - RESERVE_MS - 1;

    assertThat(settle(scheme, tx).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
  }

  // ---------------------------------------------------------------- evidence reads

  @Test
  void noEvidenceReadStartsInTheReserveAfterASlowSubmission() {
    var store = new InMemorySettlementClaimStore();
    var scheme = scheme(store);
    String tx = tx();
    // The submission returns inside the reserve: 61 s of 75 s spent.
    backend.advanceOnSubmit = SETTLE_MS - RESERVE_MS + 1_000;

    SettleResponse response = settle(scheme, tx);

    assertThat(response.isPending()).isTrue();
    assertThat(backend.evidenceReads).hasValue(0);
    assertThat(store.claimState(CardanoTransactionDecoder.decode(tx).txHash()))
        .contains(SettlementClaimState.SUBMITTED);
  }

  @Test
  void aSubmissionFailingInTheReserveIsPendingWithoutAReadAndIsNeverSentAgain() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = tx();
    backend.advanceOnSubmit = SETTLE_MS - RESERVE_MS + 1_000;
    backend.submitError = new IllegalStateException("read timed out");

    SettleResponse response = settle(scheme, tx);

    assertThat(response.isPending()).isTrue();
    assertThat(backend.evidenceReads).hasValue(0);
    assertThat(backend.submitted).hasSize(1);

    // The retry resumes the claim within its own fresh budget: it reads, and never submits again.
    backend.advanceOnSubmit = 0;
    backend.submitError = null;
    backend.evidence.put(CardanoTransactionDecoder.decode(tx).txHash(),
        new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    SettleResponse resumed = settle(scheme, tx);
    assertThat(resumed.success()).isTrue();
    assertThat(backend.evidenceReads.get()).isPositive();
    assertThat(backend.submitted).hasSize(1);
  }

  // ---------------------------------------------------------------- options

  @Test
  void theReserveDefaultsTo15SecondsAtMostHalfTheSettleTimeoutAndMustBeShorterThanIt() {
    assertThat(ExactCardanoFacilitatorOptions.defaults().chainCallReserve()).isEqualTo(Duration.ofSeconds(15));
    assertThat(ExactCardanoFacilitatorOptions.builder().settleTimeout(Duration.ofSeconds(20)).build()
        .chainCallReserve()).isEqualTo(Duration.ofSeconds(10));
    assertThat(ExactCardanoFacilitatorOptions.builder().chainCallReserve(Duration.ofSeconds(25)).build()
        .chainCallReserve()).isEqualTo(Duration.ofSeconds(25));
    assertThat(ExactCardanoFacilitatorOptions.builder().chainCallReserve(Duration.ZERO).build()
        .chainCallReserve()).isEqualTo(Duration.ZERO);
    assertThatThrownBy(() -> ExactCardanoFacilitatorOptions.builder().chainCallReserve(Duration.ofSeconds(75))
        .build()).isInstanceOf(IllegalArgumentException.class);
    assertThatThrownBy(() -> ExactCardanoFacilitatorOptions.builder().chainCallReserve(Duration.ofSeconds(-1))
        .build()).isInstanceOf(IllegalArgumentException.class);
    assertThat(new ExactCardanoFacilitatorOptions(null, false, null, null, null, null, null, null, null, 0,
        null, null, 0).chainCallReserve()).isEqualTo(Duration.ofSeconds(15));
  }

  // ---------------------------------------------------------------- warnings

  /** Collects what the scheme logs while it is built. */
  private static List<LogRecord> logsWhileBuilding(Runnable build) {
    Logger logger = Logger.getLogger(ExactCardanoFacilitatorScheme.class.getName());
    List<LogRecord> records = new ArrayList<>();
    Handler handler = new Handler() {
      @Override
      public void publish(LogRecord record) {
        records.add(record);
      }

      @Override
      public void flush() {}

      @Override
      public void close() {}
    };
    logger.addHandler(handler);
    try {
      build.run();
    } finally {
      logger.removeHandler(handler);
    }
    return records;
  }

  @Test
  void aConfirmationTimeoutAboveTheSettleTimeoutIsLogged() {
    List<LogRecord> records = logsWhileBuilding(() -> new ExactCardanoFacilitatorScheme(new StubBackend(), null,
        ExactCardanoFacilitatorOptions.builder().confirmationTimeout(Duration.ofSeconds(120)).build()));

    assertThat(records).anySatisfy(r -> {
      assertThat(r.getLevel()).isEqualTo(Level.WARNING);
      assertThat(r.getMessage()).contains("confirmationTimeout").contains("settleTimeout");
    });
  }

  @Test
  void theDefaultsLogNothing() {
    assertThat(logsWhileBuilding(() -> new ExactCardanoFacilitatorScheme(new StubBackend()))).isEmpty();
    assertThat(logsWhileBuilding(() -> new ExactCardanoFacilitatorScheme(new StubBackend(), null,
        ExactCardanoFacilitatorOptions.builder().confirmationTimeout(Duration.ofSeconds(75)).build()))).isEmpty();
  }

  @Test
  void aBlockfrostBackendThatWaitsForInclusionInSubmitIsLogged() {
    BlockfrostChainBackend waiting = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network(NETWORK).projectId("p").build());
    BlockfrostChainBackend notWaiting = new BlockfrostChainBackend(BlockfrostChainBackend.Config.builder()
        .network(NETWORK).projectId("p").awaitConfirmation(false).build());

    assertThat(logsWhileBuilding(() -> new ExactCardanoFacilitatorScheme(waiting)))
        .anySatisfy(r -> assertThat(r.getMessage()).contains("awaitConfirmation"));
    assertThat(logsWhileBuilding(() -> new ExactCardanoFacilitatorScheme(notWaiting))).isEmpty();
  }
}
