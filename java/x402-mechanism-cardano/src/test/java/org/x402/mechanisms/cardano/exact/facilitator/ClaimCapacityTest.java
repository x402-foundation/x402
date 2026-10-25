package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.account.Account;
import com.bloxbean.cardano.client.common.model.Networks;
import com.fasterxml.jackson.databind.JsonNode;
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
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.StubBackend;
import org.x402.mechanisms.cardano.testing.TxBuilder;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * The claim store cannot be filled for free: a transaction must carry a TTL, a claim that could
 * never expire is refused, and submissions whose outcome is unknown give way under pressure.
 */
class ClaimCapacityTest {

  private static final String NETWORK = "cardano:preprod";
  private static final String PAYER = TxBuilder.walletAddress();
  private static final String PAY_TO =
      new Account(Networks.testnet(), "test walk nut penalty hip pave soap entry language right filter choice", 1)
          .baseAddress();
  private static final String NONCE_HASH = TxBuilder.hash32(0xaa);
  private static final String NONCE = NONCE_HASH + "#0";
  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private final StubBackend backend = new StubBackend();

  private TxBuilder plain() {
    backend.unspent(NONCE, PAYER, 10_000_000, Map.of());
    return TxBuilder.create()
        .input(NONCE_HASH, 0)
        .output(PAY_TO, 2_000_000, Map.of(), null, false)
        .output(PAYER, 7_800_000, Map.of(), null, false)
        .fee(200_000)
        .ttl(backend.slot + 300)
        .signWith(TxBuilder.WALLET);
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

  private static ExactCardanoFacilitatorOptions.Builder fast(SettlementClaimStore store) {
    return ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(store);
  }

  private static String hash(String tx) {
    return CardanoTransactionDecoder.decode(tx).txHash();
  }

  /** A subclass whose verification admits anything, as a too-lenient override would. */
  private static final class Lenient extends ExactCardanoFacilitatorScheme {
    private final boolean fail;

    Lenient(CardanoChainBackend backend, SettlementClaimStore store, boolean fail) {
      super(backend, null, fast(store).build());
      this.fail = fail;
    }

    @Override
    protected VerifyResponse verifyPayment(PaymentPayload payload, PaymentRequirements requirements) {
      if (fail) {
        throw new IllegalStateException("override bug");
      }
      return VerifyResponse.valid(PAYER);
    }
  }

  @Test
  void verifyRejectsATransactionWithoutTtl() {
    String tx = plain().ttl(null).build();
    InMemorySettlementClaimStore store = new InMemorySettlementClaimStore();
    ExactCardanoFacilitatorScheme scheme = new ExactCardanoFacilitatorScheme(backend, null, fast(store).build());

    VerifyResponse verdict = scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);
    SettleResponse settled = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(settled.errorReason()).isEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(backend.submitted).isEmpty();
    assertThat(store.claimState(hash(tx))).isEmpty();
  }

  @Test
  void settleRefusesATtlLessTransactionAdmittedByAnOverride() {
    String tx = plain().ttl(null).build();
    InMemorySettlementClaimStore store = new InMemorySettlementClaimStore();

    SettleResponse settled = new Lenient(backend, store, false).settle(payload(tx), requirements(),
        FacilitatorContext.EMPTY);

    assertThat(settled.errorReason()).isEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(backend.submitted).isEmpty();
    assertThat(store.claimState(hash(tx))).isEmpty();
  }

  @Test
  void aThrowingVerifyOverrideReleasesItsClaim() {
    String tx = plain().build();
    InMemorySettlementClaimStore store = new InMemorySettlementClaimStore();

    SettleResponse settled = new Lenient(backend, store, true).settle(payload(tx), requirements(),
        FacilitatorContext.EMPTY);

    assertThat(settled.errorReason()).isEqualTo(CardanoErrors.INVALID_PAYLOAD + "_verification_error");
    assertThat(backend.submitted).isEmpty();
    assertThat(store.claimState(hash(tx))).isEmpty();
  }

  @Test
  void aBroadcastTtlLessTransactionStillResumes() {
    String tx = plain().ttl(null).build();
    InMemorySettlementClaimStore store = new InMemorySettlementClaimStore();
    store.claimSettlement(new SettlementClaim(hash(tx), "earlier-owner", null, null));
    store.markSubmitted(hash(tx), "earlier-owner");
    ExactCardanoFacilitatorScheme scheme = new ExactCardanoFacilitatorScheme(backend, null, fast(store).build());

    SettleResponse resumed = scheme.settle(payload(tx), requirements(), FacilitatorContext.EMPTY);
    VerifyResponse verdict = scheme.verify(payload(tx), requirements(), FacilitatorContext.EMPTY);

    assertThat(resumed.errorReason()).isNotEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(verdict.invalidReason()).isNotEqualTo(CardanoErrors.TTL_TOO_FAR);
    assertThat(backend.submitted).isEmpty();
  }

  private record Payment(PaymentPayload payload, PaymentRequirements requirements, String tx) {
    static Payment of(String fixtureId) {
      JsonNode f = Vectors.fixture(fixtureId);
      PaymentPayload payload = Vectors.payload(f.get("payload"));
      return new Payment(payload, Vectors.requirements(f.get("requirements")),
          (String) payload.payload().get("transaction"));
    }
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme, Payment p) {
    return scheme.settle(p.payload(), p.requirements(), FacilitatorContext.EMPTY);
  }

  @Test
  void ambiguousSubmitFailuresCannotExhaustTheStore() {
    Payment p = Payment.of("01-default-happy");
    Payment other = Payment.of("01e-native-asset-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy")
        .submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast(new InMemorySettlementClaimStore(1, FIXED)).build());

    // Deliberate requirement change (D2, user-approved 2026-10-14): an unknown submit outcome
    // was exact_cardano_settlement_failed; it is pending (the claim is kept either way).
    assertThat(settle(scheme, p).errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    chain.submitMode(FakeChain.SubmitMode.ACCEPT);
    SettleResponse next = settle(scheme, other);

    assertThat(next.errorMessage()).isNotEqualTo("the Cardano settlement store is at capacity");
    assertThat(chain.submissions()).contains(other.tx());
  }

  @Test
  void aResumeCannotPinAnUnconfirmedRecord() {
    Payment p = Payment.of("01-default-happy");
    Payment other = Payment.of("01e-native-asset-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy")
        .submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast(new InMemorySettlementClaimStore(1, FIXED)).build());

    // Deliberate requirement change (D2, user-approved 2026-10-14): an unknown submit outcome
    // was exact_cardano_settlement_failed; it is pending (the claim is kept either way).
    assertThat(settle(scheme, p).errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    assertThat(settle(scheme, p).success()).isFalse();
    chain.submitMode(FakeChain.SubmitMode.ACCEPT);
    SettleResponse next = settle(scheme, other);

    assertThat(next.errorMessage()).isNotEqualTo("the Cardano settlement store is at capacity");
    assertThat(chain.submissions()).contains(other.tx());
  }

  @Test
  void anUnconfirmedRecordThatTheLedgerShowsIsKept() {
    Payment p = Payment.of("01-default-happy");
    Payment other = Payment.of("01e-native-asset-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy")
        .submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, fast(new InMemorySettlementClaimStore(1, FIXED)).build());

    // Deliberate requirement change (D2, user-approved 2026-10-14): an unknown submit outcome
    // was exact_cardano_settlement_failed; it is pending (the claim is kept either way).
    assertThat(settle(scheme, p).errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    chain.include(p.tx(), 0);
    assertThat(settle(scheme, p).isPending()).isTrue();
    SettleResponse next = settle(scheme, other);

    assertThat(next.errorMessage()).isEqualTo("the Cardano settlement store is at capacity");
  }

  @Test
  void aPendingAnswerAfterAFailedLookupKeepsTheRecord() {
    Payment p = Payment.of("01-default-happy");
    Payment other = Payment.of("01e-native-asset-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy", "01e-native-asset-happy")
        .submitMode(FakeChain.SubmitMode.THROW_AFTER_BROADCAST);
    java.util.concurrent.atomic.AtomicInteger reads = new java.util.concurrent.atomic.AtomicInteger();
    CardanoChainBackend blip = new CardanoChainBackend() {
      @Override
      public org.x402.mechanisms.cardano.chain.UtxoSnapshot getUtxo(String ref, String network) {
        return chain.getUtxo(ref, network);
      }

      @Override
      public long getCurrentSlot(String network) {
        return chain.getCurrentSlot(network);
      }

      @Override
      public com.bloxbean.cardano.client.api.model.ProtocolParams getProtocolParameters(
          String network) {
        return chain.getProtocolParameters(network);
      }

      @Override
      public org.x402.mechanisms.cardano.chain.SubmissionResult submitTransaction(String tx,
          String network) {
        return chain.submitTransaction(tx, network);
      }

      @Override
      public boolean supportsTransactionEvidence() {
        return true;
      }

      @Override
      public org.x402.mechanisms.cardano.chain.SettlementEvidence getTransactionEvidence(
          String txHash, String network) {
        if (reads.getAndIncrement() == 0) {
          throw new IllegalStateException("provider blip");
        }
        // The ledger shows it (inclusion, not yet the required depth).
        return new org.x402.mechanisms.cardano.chain.SettlementEvidence(
            org.x402.mechanisms.cardano.chain.SettlementEvidence.Status.CONFIRMED, 0);
      }
    };
    var scheme = new ExactCardanoFacilitatorScheme(blip, null,
        fast(new InMemorySettlementClaimStore(1, FIXED)).build());

    assertThat(settle(scheme, p).isPending()).isTrue();
    chain.submitMode(FakeChain.SubmitMode.ACCEPT);
    SettleResponse next = settle(scheme, other);

    assertThat(next.errorMessage()).isEqualTo("the Cardano settlement store is at capacity");
  }
}

