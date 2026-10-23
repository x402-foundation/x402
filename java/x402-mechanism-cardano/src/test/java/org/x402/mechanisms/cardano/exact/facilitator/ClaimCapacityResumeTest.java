package org.x402.mechanisms.cardano.exact.facilitator;

import static org.assertj.core.api.Assertions.assertThat;

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
import org.x402.mechanisms.cardano.testing.FakeChain;
import org.x402.mechanisms.cardano.testing.Vectors;

/**
 * The positive side of resuming: a payment whose broadcast outcome was unknown is not sent a
 * second time when the same payment is settled again; the answer is success or pending.
 */
class ClaimCapacityResumeTest {

  private static final Clock FIXED = Clock.fixed(Instant.ofEpochMilli(Vectors.now()), ZoneOffset.UTC);

  private static ExactCardanoFacilitatorScheme scheme(FakeChain chain) {
    return new ExactCardanoFacilitatorScheme(chain, null, ExactCardanoFacilitatorOptions.builder()
        .clock(FIXED)
        .confirmationTimeout(Duration.ofMillis(5))
        .confirmationPoll(Duration.ofMillis(1))
        .settlementStore(new InMemorySettlementClaimStore(1, FIXED))
        .build());
  }

  private static SettleResponse settle(ExactCardanoFacilitatorScheme scheme, PaymentPayload payload,
      PaymentRequirements requirements) {
    return scheme.settle(payload, requirements, FacilitatorContext.EMPTY);
  }

  @Test
  void aResumedBroadcastIsNotSentAgainAndAnswersSuccessOrPending() {
    JsonNode fixture = Vectors.fixture("01-default-happy");
    PaymentPayload payload = Vectors.payload(fixture.get("payload"));
    PaymentRequirements requirements = Vectors.requirements(fixture.get("requirements"));
    String tx = (String) payload.payload().get("transaction");
    FakeChain chain = FakeChain.fromFixtures("01-default-happy")
        .submitMode(FakeChain.SubmitMode.THROW_AFTER_BROADCAST);
    ExactCardanoFacilitatorScheme scheme = scheme(chain);

    assertThat(settle(scheme, payload, requirements).isPending()).isTrue();
    assertThat(chain.submissions()).containsExactly(tx);

    chain.include(tx, 0);
    SettleResponse resumed = settle(scheme, payload, requirements);

    assertThat(resumed.success() || resumed.isPending()).isTrue();
    assertThat(chain.submissions()).containsExactly(tx);
  }
}
