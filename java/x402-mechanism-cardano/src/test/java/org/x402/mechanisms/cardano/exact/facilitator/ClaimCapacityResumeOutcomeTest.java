package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

import com.bloxbean.cardano.client.api.model.ProtocolParams;
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
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.Ccl;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.Vectors;
import org.x402.mechanisms.cardano.utils.CardanoPolicies;

/**
 * The exact outcome of resuming a broadcast whose submission outcome was unknown, in a claim
 * store with room for one claim: once the ledger shows it at the required depth the answer is
 * success with the payer, also when the re-check fails for a reason of the moment (here a
 * protocol-parameter change), and the transaction is never sent a second time.
 */
class ClaimCapacityResumeOutcomeTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);
  private static final JsonNode FIXTURE = Vectors.fixture("01-default-happy");

  /** The fake ledger, with protocol parameters a test can change after the broadcast. */
  private static final class Chain implements CardanoChainBackend {
    final FakeChain chain = FakeChain.fromFixtures("01-default-happy")
        .submitMode(FakeChain.SubmitMode.THROW_AFTER_BROADCAST);
    ProtocolParams parameters;

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
      return parameters != null ? parameters : chain.getProtocolParameters(network);
    }

    @Override
    public SubmissionResult submitTransaction(String tx, String network) {
      return chain.submitTransaction(tx, network);
    }

    @Override
    public boolean isSubmissionNeverSent(Throwable error) {
      return chain.isSubmissionNeverSent(error);
    }

    @Override
    public boolean isDefinitiveSubmissionRejection(Throwable error) {
      return chain.isDefinitiveSubmissionRejection(error);
    }

    @Override
    public boolean supportsTransactionEvidence() {
      return chain.supportsTransactionEvidence();
    }

    @Override
    public SettlementEvidence getTransactionEvidence(String txHash, String network) {
      return chain.getTransactionEvidence(txHash, network);
    }
  }

  private static ExactCardanoFacilitatorScheme scheme(Chain chain) {
    return new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(new InMemorySettlementClaimStore(1, FIXED))
        .build());
  }

  private static PaymentPayload payload() {
    return Vectors.payload(FIXTURE.get("payload"));
  }

  private static PaymentRequirements requirements() {
    return Vectors.requirements(FIXTURE.get("requirements"));
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme) {
    return scheme.settle(payload(), requirements(), FacilitatorContext.EMPTY);
  }

  private static String tx() {
    return (String) payload().payload().get("transaction");
  }

  /**
   * The broadcast's outcome was unknown: pending, sent once. Then the ledger includes it at the
   * required depth. Returns the payer the pending answer named.
   */
  private static String broadcastThenInclude(Chain chain, ExactCardanoFacilitatorScheme scheme) {
    SettleResponse first = settle(scheme);
    assertThat(first.isPending()).isTrue();
    assertThat(first.payer()).isNotBlank();
    assertThat(chain.chain.submissions()).containsExactly(tx());
    int required = CardanoPolicies.l1Confirmations(requirements().extra());
    chain.chain.include(tx(), Math.max(required, 0));
    return first.payer();
  }

  @Test
  void aConfirmedResumeAtCapacityIsSuccessWithThePayerAndNoSecondSubmission() {
    Chain chain = new Chain();
    ExactCardanoFacilitatorScheme scheme = scheme(chain);
    String payer = broadcastThenInclude(chain, scheme);

    SettleResponse resumed = settle(scheme);

    assertThat(resumed.success()).isTrue();
    assertThat(resumed.payer()).isEqualTo(payer);
    assertThat(chain.chain.submissions()).containsExactly(tx());
  }

  @Test
  void aConfirmedResumeWhoseRecheckFailsForTheMomentIsStillSuccess() {
    Chain chain = new Chain();
    ExactCardanoFacilitatorScheme scheme = scheme(chain);
    String payer = broadcastThenInclude(chain, scheme);
    // The min-UTxO price rises after the broadcast: the re-check now fails min-UTxO.
    chain.parameters = Ccl.params(1_000_000, 44, 155381);

    SettleResponse resumed = settle(scheme);

    assertThat(resumed.success()).isTrue();
    assertThat(resumed.payer()).isEqualTo(payer);
    assertThat(chain.chain.submissions()).containsExactly(tx());
  }
}
