package org.x402.mechanisms.cardano.exact.server;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.x402.core.types.PaymentRequirements;
import org.x402.core.types.SupportedKind;
import org.x402.mechanisms.cardano.testing.TxBuilder;

/**
 * The per-request option checks (confirmation policy, Masumi schema) run even when the
 * facilitator's Cardano kind advertises no capabilities: a dynamic price never reaches the
 * startup {@code validateOption}, so this is the only place they are checked.
 */
class OptionChecksWithoutCapabilitiesTest {

  private static final String PREPROD = "cardano:preprod";
  private static final SupportedKind BARE = new SupportedKind(2, "exact", PREPROD, null);

  private static PaymentRequirements requirements(Map<String, Object> extra) {
    return new PaymentRequirements("exact", PREPROD, "lovelace", "1000000", TxBuilder.walletAddress(), 600, extra);
  }

  @Test
  void anInvalidConfirmationPolicyIsRefused() {
    var scheme = new ExactCardanoServerScheme();
    assertThatThrownBy(() -> scheme.enhancePaymentRequirements(
            requirements(Map.of("confirmationPolicy", Map.of("l1Confirmations", 99))), BARE, List.of()))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("invalid confirmation policy");
  }

  @Test
  void aMasumiQuoteThatViolatesTheSchemaIsRefused() {
    var scheme = new ExactCardanoServerScheme();
    assertThatThrownBy(() -> scheme.enhancePaymentRequirements(
            requirements(Map.of("assetTransferMethod", "masumi", "terms", Map.of())), BARE, List.of()))
        .isInstanceOf(IllegalArgumentException.class)
        .hasMessageContaining("Masumi requirements are invalid");
  }

  @Test
  void aValidOptionStillPasses() {
    var scheme = new ExactCardanoServerScheme();
    PaymentRequirements enhanced = scheme.enhancePaymentRequirements(
        requirements(Map.of("confirmationPolicy", Map.of("l1Confirmations", 1))), BARE, List.of());
    assertThat(enhanced.extra()).containsEntry("confirmationPolicy", Map.of("l1Confirmations", 1));
  }

  @Test
  void startupFacilitatorChecksStillLeaveTheOptionToValidateOption() {
    var scheme = new ExactCardanoServerScheme();
    assertThat(scheme.validateFacilitatorSupport(PREPROD, BARE, List.of(),
        Map.of("confirmationPolicy", Map.of("l1Confirmations", 99)))).isNull();
    assertThat(scheme.validateOption(PREPROD, Map.of("confirmationPolicy", Map.of("l1Confirmations", 99))))
        .contains("invalid confirmation policy");
  }
}
