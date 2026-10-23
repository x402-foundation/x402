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
import org.x402.mechanisms.cardano.utils.CardanoTransactionDecoder;
import org.x402.mechanisms.cardano.chain.CardanoChainBackend;
import org.x402.mechanisms.cardano.chain.SettlementEvidence;
import org.x402.mechanisms.cardano.chain.SubmissionResult;
import org.x402.mechanisms.cardano.chain.UtxoSnapshot;
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * A resumed settlement is "expired" only when the provider has indexed past the transaction's
 * validity window and a successful read shows the transaction absent. The wall clock alone, or a
 * failing evidence read, keeps it pending, because the payment may still land.
 */
class ExpiryRequiresProvenAbsenceTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  /** FakeChain with a separate indexed slot and an evidence read that can fail. */
  private static final class LaggingChain implements CardanoChainBackend {
    final FakeChain chain = FakeChain.fromFixtures("01-default-happy");
    long indexedSlot;
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
    public long getIndexedSlot(String network) {
      return indexedSlot;
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
      return chain.getTransactionEvidence(txHash, network);
    }
  }

  private static PaymentPayload payload() {
    return Vectors.payload(Vectors.fixture("01-default-happy").get("payload"));
  }

  private static PaymentRequirements requirements() {
    JsonNode f = Vectors.fixture("01-default-happy");
    return Vectors.requirements(f.get("requirements"));
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme) {
    return scheme.settle(payload(), requirements(), FacilitatorContext.EMPTY);
  }

  private static long ttl() {
    return CardanoTransactionDecoder.decode((String) payload().payload().get("transaction"))
        .ttlSlot().longValueExact();
  }

  private static ExactCardanoFacilitatorScheme scheme(LaggingChain backend) {
    return new ExactCardanoFacilitatorScheme(backend, null, ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED).confirmationTimeout(Duration.ofMillis(5)).confirmationPoll(Duration.ofMillis(1))
        .build());
  }

  @Test
  void theWallClockPastTheWindowCannotExpireWhileTheProviderLags() {
    LaggingChain backend = new LaggingChain();
    backend.indexedSlot = backend.chain.currentSlot();
    var scheme = scheme(backend);
    assertThat(settle(scheme).isPending()).isTrue();

    backend.chain.currentSlot(ttl() + 1_000);
    backend.indexedSlot = ttl();

    assertThat(settle(scheme).isPending()).isTrue();
  }

  @Test
  void aFailingEvidenceReadPastTheWindowStaysPending() {
    LaggingChain backend = new LaggingChain();
    backend.indexedSlot = backend.chain.currentSlot();
    var scheme = scheme(backend);
    assertThat(settle(scheme).isPending()).isTrue();

    backend.chain.currentSlot(ttl() + 1_000);
    backend.indexedSlot = ttl() + 1_000;
    backend.evidenceFails = true;

    assertThat(settle(scheme).isPending()).isTrue();
  }

  @Test
  void provenAbsenceWithTheProviderPastTheWindowExpires() {
    LaggingChain backend = new LaggingChain();
    backend.indexedSlot = backend.chain.currentSlot();
    var scheme = scheme(backend);
    assertThat(settle(scheme).isPending()).isTrue();

    backend.chain.currentSlot(ttl() + 1_000);
    backend.indexedSlot = ttl() + 1_000;

    SettleResponse expired = settle(scheme);
    assertThat(expired.extra()).containsEntry("status", "expired");
  }
}
