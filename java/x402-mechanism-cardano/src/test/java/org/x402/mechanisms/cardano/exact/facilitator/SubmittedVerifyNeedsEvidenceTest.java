package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;
import org.x402.core.FacilitatorContext;
import org.x402.core.types.PaymentPayload;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.VerifyResponse;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * Public verify of a transaction whose settlement was broadcast with an unknown outcome (the claim
 * stays SUBMITTED) accepts it only with ledger or mempool evidence for that transaction. Without
 * proof of broadcast, the pre-broadcast checks are never skipped.
 */
class SubmittedVerifyNeedsEvidenceTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  /** A chain whose submissions fail with an unknown outcome and whose evidence the test sets. */
  private static final class Chain implements CardanoChainBackend {
    final FakeChain chain = FakeChain.fromFixtures("01-default-happy")
        .submitMode(FakeChain.SubmitMode.THROW_TRANSPORT);
    SettlementEvidence evidence = SettlementEvidence.unknown();
    boolean evidenceFails;

    @Override
    public UtxoSnapshot getUtxo(String ref, String network) {
      return chain.getUtxo(ref, network);
    }

    @Override
    public long getCurrentSlot(String network) {
      return chain.getCurrentSlot(network);
    }

    @Override
    public ProtocolParams getProtocolParameters(String network) {
      return chain.getProtocolParameters(network);
    }

    @Override
    public SubmissionResult submitTransaction(String tx, String network) {
      return chain.submitTransaction(tx, network);
    }

    @Override
    public boolean supportsTransactionEvidence() {
      return true;
    }

    @Override
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      if (evidenceFails) {
        throw new IllegalStateException("provider unavailable");
      }
      return evidence;
    }
  }

  private static PaymentPayload payload() {
    return Vectors.payload(Vectors.fixture("01-default-happy").get("payload"));
  }

  private static PaymentRequirements requirements() {
    return Vectors.requirements(Vectors.fixture("01-default-happy").get("requirements"));
  }

  private static ExactCardanoFacilitatorScheme submitted(Chain chain) {
    var scheme = new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED).confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1))
        .build());
    assertThat(scheme.settle(payload(), requirements(), FacilitatorContext.EMPTY).success()).isFalse();
    assertThat(chain.chain.submissions()).hasSize(1);
    return scheme;
  }

  private static VerifyResponse verify(ExactCardanoFacilitatorScheme scheme) {
    return scheme.verify(payload(), requirements(), FacilitatorContext.EMPTY);
  }

  @Test
  void withoutEvidenceTheBroadcastTransactionIsNotValid() {
    Chain chain = new Chain();
    var scheme = submitted(chain);

    VerifyResponse verdict = verify(scheme);

    assertThat(verdict.isValid()).isFalse();
    assertThat(verdict.invalidReason()).isEqualTo(CardanoErrors.SETTLEMENT_PENDING);
  }

  @Test
  void aFailingEvidenceReadIsNotValid() {
    Chain chain = new Chain();
    var scheme = submitted(chain);
    chain.evidenceFails = true;

    assertThat(verify(scheme).isValid()).isFalse();
  }

  @Test
  void mempoolEvidenceMakesTheBroadcastTransactionValid() {
    Chain chain = new Chain();
    var scheme = submitted(chain);
    chain.evidence = new SettlementEvidence(SettlementEvidence.Status.MEMPOOL, -1);

    assertThat(verify(scheme).isValid()).isTrue();
  }

  @Test
  void ledgerEvidenceMakesTheBroadcastTransactionValid() {
    Chain chain = new Chain();
    var scheme = submitted(chain);
    chain.evidence = new SettlementEvidence(SettlementEvidence.Status.CONFIRMED, 0);

    assertThat(verify(scheme).isValid()).isTrue();
  }
}
