package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.function.Predicate;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SettleResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.testing.ClassifyingBackend;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.FlakyStore;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * A failing settlement store never makes settle throw, never turns a broadcast transaction into
 * a rejection, and never lets success be reported unless the store recorded it.
 */
class StoreFailureOutcomesTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private final FlakyStore store = new FlakyStore();

  private record Payment(PaymentPayload payload, PaymentRequirements requirements, String tx) {
    static Payment of(String fixtureId) {
      JsonNode f = Vectors.fixture(fixtureId);
      PaymentPayload payload = Vectors.payload(f.get("payload"));
      return new Payment(payload, Vectors.requirements(f.get("requirements")),
          (String) payload.payload().get("transaction"));
    }

    String hash() {
      return CardanoTransactionDecoder.decode(tx).txHash();
    }
  }

  private ExactCardanoFacilitatorScheme scheme(CardanoChainBackend backend) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(store)
        .build());
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme, Payment p) {
    return scheme.settle(p.payload(), p.requirements(), FacilitatorContext.EMPTY);
  }

  private static ClassifyingBackend classifying(FakeChain chain, Predicate<Throwable> definitive) {
    return new ClassifyingBackend(chain, definitive);
  }

  @Test
  void aStoreFailureAfterBroadcastIsNeverClassifiedAsRejection() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    store.failMarkSubmitted.set(1);

    SettleResponse response = settle(scheme(classifying(chain, e -> true)), p);

    assertThat(response.errorReason()).isNotEqualTo(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED);
    assertThat(store.claimState(p.hash())).isNotEqualTo(java.util.Optional.of(SettlementClaimState.REJECTED));
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void aWrongHashIsNeverClassifiedAsRejection() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.WRONG_HASH);

    SettleResponse response = settle(scheme(classifying(chain, e -> true)), p);

    assertThat(response.success()).isFalse();
    assertThat(response.errorReason()).isNotEqualTo(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED);
    assertThat(store.claimState(p.hash())).isNotEqualTo(java.util.Optional.of(SettlementClaimState.REJECTED));
  }

  @Test
  void aMissedSubmittedMarkStillReportsPendingAndNeverRebroadcasts() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    store.failMarkSubmitted.set(1);
    ExactCardanoFacilitatorScheme scheme = scheme(chain);

    SettleResponse first = settle(scheme, p);
    SettleResponse retry = settle(scheme, p);

    assertThat(first.isPending()).as("%s", first).isTrue();
    assertThat(first.transaction()).isEqualTo(p.hash());
    assertThat(retry.success()).isFalse();
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void markSettledFailureReportsPendingNotSuccess() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    ExactCardanoFacilitatorScheme scheme = scheme(chain);
    assertThat(settle(scheme, p).isPending()).isTrue();
    chain.include(p.tx(), 1);

    store.failMarkSettled.set(1);
    SettleResponse failedRecord = settle(scheme, p);
    SettleResponse recovered = settle(scheme, p);
    SettleResponse again = settle(scheme, p);

    assertThat(failedRecord.success()).isFalse();
    assertThat(failedRecord.isPending()).as("%s", failedRecord).isTrue();
    assertThat(recovered.success()).isTrue();
    assertThat(again.errorReason()).isEqualTo(CardanoErrors.DUPLICATE_SETTLEMENT);
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void aStoreThatIsDownAfterBroadcastNeverThrowsOrReportsSuccess() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.ACCEPT_CONFIRMED);
    store.failMarkSubmitted.set(-1);
    store.failMarkSettled.set(-1);
    ExactCardanoFacilitatorScheme scheme = scheme(chain);

    SettleResponse first = settle(scheme, p);
    chain.include(p.tx(), 1);
    SettleResponse second = settle(scheme, p);

    assertThat(first.success()).isFalse();
    assertThat(second.success()).isFalse();
    assertThat(chain.submissions()).containsExactly(p.tx());
  }

  @Test
  void claimFailureFailsBeforeBroadcast() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    store.failClaim.set(1);

    SettleResponse response = settle(scheme(chain), p);

    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_FAILED);
    assertThat(response.errorMessage()).isEqualTo("settlement store unavailable");
    assertThat(chain.submissions()).isEmpty();
  }

  @Test
  void releaseFailureStillReportsTheVerdict() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    store.failRelease.set(1);
    PaymentRequirements otherPayee = new PaymentRequirements(p.requirements().scheme(),
        p.requirements().network(), p.requirements().asset(), "999999999999",
        p.requirements().payTo(), p.requirements().maxTimeoutSeconds(), p.requirements().extra());

    SettleResponse response = scheme(chain).settle(p.payload(), otherPayee, FacilitatorContext.EMPTY);

    assertThat(response.success()).isFalse();
    assertThat(response.errorReason()).startsWith("invalid_exact_cardano_payload");
    assertThat(chain.submissions()).isEmpty();
  }

  @Test
  void markRejectedFailureStillReportsTheRejection() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.THROW_DEFINITIVE);
    store.failMarkRejected.set(1);

    SettleResponse response = settle(scheme(chain), p);

    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_DEFINITIVELY_REJECTED);
  }

  @Test
  void unconfirmedMarkFailureStillReportsSettlementFailed() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);
    store.failMarkSubmitted.set(-1);

    SettleResponse response = settle(scheme(chain), p);

    // Deliberate requirement change (D2, user-approved 2026-10-14): was SETTLEMENT_FAILED; an
    // unknown submit outcome is pending even when the store write fails.
    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
  }

  @Test
  void aThrowingClassifierIsNonDefinitive() {
    Payment p = Payment.of("01-default-happy");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy").submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);

    SettleResponse response = settle(scheme(classifying(chain, e -> {
      throw new IllegalStateException("classifier bug");
    })), p);

    // Deliberate requirement change (D2, user-approved 2026-10-14): was SETTLEMENT_FAILED.
    assertThat(response.errorReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
    assertThat(store.claimState(p.hash())).contains(SettlementClaimState.SUBMITTED);
  }
}
