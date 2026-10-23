package org.x402.mechanisms.cardano;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.x402.mechanisms.cardano.utils.CardanoErrors;

/** The wire spelling of the Masumi allowlist refusal, as the TypeScript constants spell it. */
class MasumiErrorCodeTest {

  @Test
  void contractMismatchUsesThePayloadSpelling() {
    assertThat(CardanoErrors.MASUMI_CONTRACT_MISMATCH)
        .isEqualTo("invalid_exact_cardano_payload_masumi_contract_mismatch");
  }
}
