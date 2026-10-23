package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.api.model.ProtocolParams;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
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
 * The paid retry of a broadcast payment: when its re-check fails for a reason that depends on the
 * moment, verify lets a bound claim through to settle (whose resume lets the ledger decide and
 * never broadcasts again), and keeps an unbound one pending.
 */
class BoundPaidRetryVerifyTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final ProtocolParams PRICEY = Ccl.params(1_000_000, 44, 155381);
  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private final StubBackend backend = new StubBackend();

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
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(store)
        .build());
  }

  private static String hash(String tx) {
    return CardanoTransactionDecoder.decode(tx).txHash();
  }

  private VerifyResponse verify(ExactCardanoFacilitatorScheme scheme, String tx) {
    return scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
  }

  /** Broadcasts once, answered pending: the claim is SUBMITTED, bound, with the payer recorded. */
  private String broadcastPending(ExactCardanoFacilitatorScheme scheme) {
    String tx = tx();
    assertThat(scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
    return tx;
  }

  @Test
  void aProviderOutageDuringTheRecheckLetsABoundRetryThroughWithTheRecordedPayer() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    // The re-check fails before it resolves the payer: the one recorded at the broadcast fence stands in.
    backend.slotError = new IllegalStateException("provider down");

    VerifyResponse verdict = verify(scheme, tx);

    assertThat(verdict.isValid()).isTrue();
    assertThat(verdict.payer()).isEqualTo(PAYER);
    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isTrue();
    assertThat(settled.payer()).isEqualTo(PAYER);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aValidVerdictForABoundRetryNeverLeadsToASecondBroadcastWhileTheLedgerLags() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.parameters = PRICEY;
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, -1));

    assertThat(verify(scheme, tx).isValid()).isTrue();
    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(settled.isPending()).isTrue();
    assertThat(settled.errorMessage()).contains(CardanoErrors.MIN_UTXO_INSUFFICIENT);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void anUnboundClaimStaysPendingWhenTheRecheckFailsForTheMoment() {
    var store = new InMemorySettlementClaimStore();
    String tx = tx();
    store.claimSettlement(new SettlementClaim(hash(tx), "earlier", null, null));
    store.markSubmitted(hash(tx), "earlier");
    backend.parameters = PRICEY;
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));

    VerifyResponse verdict = verify(scheme(store), tx);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
  }

  @Test
  void aBoundClaimWithoutAnyKnownPayerStaysPending() {
    var store = new InMemorySettlementClaimStore();
    String tx = tx();
    // Bound, but claimed without passing the broadcast fence: no payer is recorded.
    store.claimSettlement(new SettlementClaim(hash(tx), "earlier", null, null,
        SettlementBinding.of(requirements(), null)));
    store.markSubmitted(hash(tx), "earlier");
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    backend.slotError = new IllegalStateException("provider down");

    VerifyResponse verdict = verify(scheme(store), tx);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
  }

  @Test
  void withoutEvidenceABoundRetryWhoseRecheckFailsStaysPending() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.parameters = PRICEY;

    VerifyResponse verdict = verify(scheme, tx);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
  }

  @Test
  void aTerminalRecheckStillRefusesTheRetry() {
    var scheme = scheme(new InMemorySettlementClaimStore());
    String tx = broadcastPending(scheme);
    backend.evidence.put(hash(tx), new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    Map<String, Object> p = new LinkedHashMap<>(payload(tx).payload());
    p.put("nonce", TxBuilder.hash32(0xbb) + "#0");

    VerifyResponse verdict = scheme.verify(new PaymentPayload(2, null, requirements(), p, null), requirements(),
        FacilitatorContext.EMPTY);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.NONCE_NOT_IN_INPUTS);
  }
}
