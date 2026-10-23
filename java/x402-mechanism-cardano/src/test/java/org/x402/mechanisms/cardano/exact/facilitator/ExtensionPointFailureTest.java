package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.utils.CardanoErrors;

/** A throwing override or backend capability never escapes the public verify and settle. */
class ExtensionPointFailureTest {

  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO = new Account(Networks.testnet(),
      "test walk nut penalty hip pave soap entry language right filter choice", 1).baseAddress();
  private static final String HASH = TxBuilder.hash32(0xaa);
  private static final PaymentRequirements REQ =
      new PaymentRequirements("exact", "cardano:preprod", "lovelace", "2000000", PAY_TO, 600, Map.of());

  private static PaymentPayload payload(StubBackend backend) {
    backend.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());
    String tx = TxBuilder.create()
        .input(HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET)
        .build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", tx);
    p.put("nonce", HASH + "#0");
    return new PaymentPayload(2, null, REQ, p, null);
  }

  private static ExactCardanoFacilitatorOptions options() {
    return ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1)).build();
  }

  @Test
  void aThrowingVerifyOverrideIsAnInvalidVerdict() {
    StubBackend backend = new StubBackend();
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, options()) {
      @Override
      protected VerifyResponse verifyPayment(PaymentPayload payload, PaymentRequirements requirements) {
        throw new IllegalStateException("override bug");
      }
    };

    VerifyResponse verdict = scheme.verify(payload(backend), REQ, FacilitatorContext.EMPTY);

    assertThat(verdict.isValid()).isFalse();
  }

  @Test
  void aCapabilityThatThrowsAfterBroadcastStillAnswersSettle() {
    StubBackend backend = new StubBackend() {
      private boolean broadcast;

      @Override
      public SubmissionResult submitTransaction(String tx, String network) {
        broadcast = true;
        return super.submitTransaction(tx, network);
      }

      @Override
      public boolean supportsTransactionEvidence() {
        if (broadcast) {
          throw new IllegalStateException("capability probe failed");
        }
        return super.supportsTransactionEvidence();
      }
    };
    var scheme = new ExactCardanoFacilitatorScheme(backend, null, options());

    SettleResponse settled = scheme.settle(payload(backend), REQ, FacilitatorContext.EMPTY);

    assertThat(backend.submitted).hasSize(1);
    assertThat(settled).isNotNull();
  }

  @Test
  void nullArgumentsAreAFailedSettlementNotAnException() {
    var scheme = new ExactCardanoFacilitatorScheme(new StubBackend(), null, options());

    assertThat(scheme.settle(null, REQ, FacilitatorContext.EMPTY).success()).isFalse();
    assertThat(scheme.settle(payload(new StubBackend()), null, FacilitatorContext.EMPTY).success()).isFalse();
    assertThat(scheme.verify(null, REQ, FacilitatorContext.EMPTY).isValid()).isFalse();
  }

  @Test
  void waitsBeyondMillisecondRangeAreRefusedUpFront() {
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> ExactCardanoFacilitatorOptions.builder()
            .confirmationTimeout(Duration.ofSeconds(Long.MAX_VALUE)).build())
        .isInstanceOf(IllegalArgumentException.class);
    org.assertj.core.api.Assertions.assertThatThrownBy(() -> ExactCardanoFacilitatorOptions.builder()
            .confirmationPoll(Duration.ofSeconds(Long.MAX_VALUE)).build())
        .isInstanceOf(IllegalArgumentException.class);
  }

  @Test
  void chainLookupsBeyondTheBudgetAreALookupFailure() {
    StubBackend slow = new StubBackend() {
      @Override
      public org.x402.mechanisms.cardano.chain.UtxoSnapshot getUtxo(String ref, String network) {
        try {
          Thread.sleep(40);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        }
        return super.getUtxo(ref, network);
      }
    };
    slow.unspent(HASH + "#0", PAYER, 10_000_000, Map.of());
    for (int i = 1; i < 6; i++) {
      slow.unspent(HASH + "#" + i, PAYER, 1_000_000, Map.of());
    }
    TxBuilder tx = TxBuilder.create();
    for (int i = 0; i < 6; i++) {
      tx.input(HASH, i);
    }
    String signed = tx.output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 12_800_000, Map.of(), null, false)
        .fee(200_000).ttl(slow.slot + 300).signWith(TxBuilder.WALLET).build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", signed);
    p.put("nonce", HASH + "#0");
    var scheme = new ExactCardanoFacilitatorScheme(slow, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1))
        .lookupTimeout(Duration.ofMillis(100)).build());

    VerifyResponse verdict = scheme.verify(new PaymentPayload(2, null, REQ, p, null), REQ,
        FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
  }

  @Test
  void moreInputsThanTheLookupBudgetAreALookupFailureBeforeAnyLookup() {
    java.util.concurrent.atomic.AtomicInteger lookups = new java.util.concurrent.atomic.AtomicInteger();
    StubBackend counting = new StubBackend() {
      @Override
      public org.x402.mechanisms.cardano.chain.UtxoSnapshot getUtxo(String ref, String network) {
        lookups.incrementAndGet();
        return super.getUtxo(ref, network);
      }
    };
    TxBuilder tx = TxBuilder.create();
    for (int i = 0; i < 3; i++) {
      counting.unspent(HASH + "#" + i, PAYER, 5_000_000, Map.of());
      tx.input(HASH, i);
    }
    String signed = tx.output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 12_800_000, Map.of(), null, false)
        .fee(200_000).ttl(counting.slot + 300).signWith(TxBuilder.WALLET).build();
    Map<String, Object> p = new LinkedHashMap<>();
    p.put("transaction", signed);
    p.put("nonce", HASH + "#0");
    var scheme = new ExactCardanoFacilitatorScheme(counting, null, ExactCardanoFacilitatorOptions.builder()
        .confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1))
        .maxInputLookups(2).build());

    VerifyResponse verdict = scheme.verify(new PaymentPayload(2, null, REQ, p, null), REQ,
        FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.CHAIN_LOOKUP_FAILED);
    assertThat(lookups.get()).isZero();
  }
}
