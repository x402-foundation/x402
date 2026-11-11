package org.x402.mechanisms.cardano.exact.masumi;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;
import org.x402.mechanisms.cardano.utils.CardanoAddresses;
import org.x402.mechanisms.cardano.utils.CardanoErrors;
import org.x402.mechanisms.cardano.testing.MasumiFixtures;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * A facilitator can pin the escrow scripts it accepts per network. A non-empty allowlist refuses
 * every other escrow, the canonical one included; an allowlisted custom deployment needs no
 * further approval.
 */
class MasumiAllowlistTest {

  private static final PaymentRequirements QUOTE = MasumiFixtures.issue(b -> { });
  private static final MasumiDeployment CUSTOM = new MasumiDeployment("1", List.of(TxBuilder.hash28(4)), "0");
  private static final PaymentRequirements CUSTOM_QUOTE = MasumiFixtures.issue(b -> b.deployment(CUSTOM));

  private static MasumiVerifier.Authorization authorize(PaymentRequirements q, Set<String> allowlist,
      MasumiDeploymentValidator deployment) {
    return MasumiVerifier.verifyAuthorization(MasumiFixtures.extra(q), q,
        new MasumiVerifier.AuthorizationOptions(null, null, deployment, null, false, null, Clock.systemUTC(),
            allowlist));
  }

  private static String escrowHash(PaymentRequirements q) {
    return CardanoAddresses.scriptPaymentCredentialHex(q.payTo());
  }

  @Test
  void anEmptyAllowlistKeepsTheDefaultRules() {
    assertThat(authorize(QUOTE, Set.of(), null).ok()).isTrue();
    assertThat(authorize(CUSTOM_QUOTE, Set.of(), null).detail())
        .isEqualTo("custom deployment requires explicit application approval");
  }

  @Test
  void anEscrowOffTheAllowlistIsAContractMismatchEvenTheCanonicalOne() {
    MasumiVerifier.Authorization refused = authorize(QUOTE, Set.of(TxBuilder.hash28(9)), null);
    assertThat(refused.ok()).isFalse();
    assertThat(refused.reason()).isEqualTo(CardanoErrors.MASUMI_CONTRACT_MISMATCH);
  }

  @Test
  void theAllowlistedCanonicalEscrowIsAccepted() {
    assertThat(authorize(QUOTE, Set.of(escrowHash(QUOTE)), null).ok()).isTrue();
  }

  @Test
  void anAllowlistedCustomDeploymentNeedsNoValidator() {
    assertThat(authorize(CUSTOM_QUOTE, Set.of(escrowHash(CUSTOM_QUOTE).toUpperCase()), claim -> false).ok()).isTrue();
  }
}
