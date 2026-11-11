package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.math.BigInteger;
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
import org.x402.mechanisms.cardano.exact.masumi.MasumiVerifier;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.utils.DecodedCardanoTransaction;

/**
 * A re-check of a broadcast payment that fails for a reason not known to depend on the moment (a
 * custom method check's, an unexpected error) fails closed for success: the paid retry's verify is
 * never valid and settle's resume never reports success, even for a bound claim the ledger shows
 * confirmed. It never fails the payment either: the answer is pending, with the reason.
 */
class UnknownRecheckReasonTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);
  private static final String CUSTOM = "operator_policy_refused";

  private final StubBackend backend = new StubBackend();

  /** A scheme whose method check can be switched to refuse, or to throw, after the broadcast. */
  private static final class Switchable extends ExactCardanoFacilitatorScheme {
    private volatile String refuse;
    private volatile RuntimeException fault;

    Switchable(StubBackend backend) {
      super(backend, null, ExactCardanoFacilitatorOptions.builder()
          .clock(FIXED)
          .confirmationTimeout(Duration.ofMillis(5))
          .confirmationPoll(Duration.ofMillis(1))
          .settlementStore(new InMemorySettlementClaimStore())
          .build());
    }

    @Override
    protected MasumiVerifier.Check runMethodSpecificChecks(PaymentRequirements requirements,
        DecodedCardanoTransaction decoded, PaymentPayload payload, String payer, BigInteger coinsPerUtxoByte) {
      if (fault != null) {
        throw fault;
      }
      if (refuse != null) {
        return new MasumiVerifier.Check(false, refuse, "refused by a custom policy");
      }
      return super.runMethodSpecificChecks(requirements, decoded, payload, payer, coinsPerUtxoByte);
    }
  }

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

  /** Broadcasts once, answered pending; then the ledger shows the transaction confirmed. */
  private String broadcastThenConfirmed(Switchable scheme) {
    String tx = tx();
    assertThat(scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY).isPending()).isTrue();
    assertThat(backend.submitted).hasSize(1);
    backend.evidence.put(CardanoTransactionDecoder.decode(tx).txHash(),
        new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 3));
    return tx;
  }

  @Test
  void aCustomReasonOnTheRecheckIsNeverValidNorSettledNorFailed() {
    Switchable scheme = new Switchable(backend);
    String tx = broadcastThenConfirmed(scheme);
    scheme.refuse = CUSTOM;

    VerifyResponse verdict = scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    assertThat(verdict.invalidMessage()).contains(CUSTOM);

    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isFalse();
    assertThat(settled.isPending()).isTrue();
    assertThat(settled.errorMessage()).contains(CUSTOM);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void anUnexpectedErrorOnTheRecheckIsNeverValidNorSettledNorFailed() {
    Switchable scheme = new Switchable(backend);
    String tx = broadcastThenConfirmed(scheme);
    scheme.fault = new IllegalStateException("custom check crashed");

    VerifyResponse verdict = scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);

    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isFalse();
    assertThat(settled.isPending()).isTrue();
    assertThat(settled.errorMessage()).contains(CardanoErrors.INVALID_PAYLOAD + "_verification_error");
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void onceTheRecheckPassesAgainTheConfirmedPaymentSettles() {
    Switchable scheme = new Switchable(backend);
    String tx = broadcastThenConfirmed(scheme);
    scheme.refuse = CUSTOM;
    assertThat(scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY).isPending()).isTrue();

    scheme.refuse = null;
    assertThat(scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY).isValid()).isTrue();
    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isTrue();
    assertThat(settled.payer()).isEqualTo(PAYER);
    assertThat(backend.submitted).hasSize(1);
  }

  @Test
  void aTerminalReasonFromACustomCheckStillFailsTheResume() {
    Switchable scheme = new Switchable(backend);
    String tx = broadcastThenConfirmed(scheme);
    scheme.refuse = CardanoErrors.SCRIPT_ADDRESS_MISMATCH;

    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    assertThat(settled.success()).isFalse();
    assertThat(settled.isPending()).isFalse();
    assertThat(settled.errorReason()).isEqualTo(CardanoErrors.SCRIPT_ADDRESS_MISMATCH);
  }
}
